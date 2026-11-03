"""Managed environment installer and quiet, authenticated service supervisor.

The plugin stages verified public assets under its own profile runtime directory.
No shell, administrator privileges, login startup item or system Python changes.
"""
from contextlib import contextmanager
import errno
import hmac
import importlib.util
import json
import math
import os
from pathlib import Path
import queue
import re
import secrets
import socket
import sys
import threading
import time
from types import SimpleNamespace
import urllib.error
import urllib.request

SOURCE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SOURCE_ROOT))
sys.path.insert(0, str(SOURCE_ROOT / 'server'))
from utils.silent_process import run as quiet_run, service_popen as quiet_popen
from utils.privacy import redacted_output, register_secret
from runtime.security import challenge_proof, is_hex, register_auth

VERSION = '0.1.0'
PYTHON_VERSION = '3.12.13'
PORT = 8891


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())


@contextmanager
def file_lock(path, timeout):
    deadline = time.monotonic() + max(0, timeout)
    with Path(path).open('a+b') as handle:
        if handle.seek(0, os.SEEK_END) == 0:
            handle.write(b'\0')
            handle.flush()
        while True:
            handle.seek(0)
            try:
                if sys.platform == 'win32':
                    import msvcrt
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError as error:
                if error.errno not in (errno.EACCES, errno.EAGAIN, errno.EDEADLK):
                    raise
                if time.monotonic() >= deadline:
                    raise TimeoutError('Managed runtime lock deadline exceeded.') from None
                time.sleep(min(0.02, max(0, deadline - time.monotonic())))
        try:
            yield
        finally:
            handle.seek(0)
            if sys.platform == 'win32':
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def bounded_read(deadline, function):
    result = queue.Queue(maxsize=1)
    def worker():
        try:
            result.put((True, function()))
        except Exception as error:
            result.put((False, error))
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise RuntimeError('Local service readiness deadline exceeded.')
    threading.Thread(target=worker, daemon=True).start()
    try:
        ok, value = result.get(timeout=remaining)
    except queue.Empty:
        raise RuntimeError('Local service readiness deadline exceeded.') from None
    if not ok:
        raise value
    return value


class ManagedRuntime:
    def __init__(self, root, create=True):
        self.root = Path(root).resolve()
        if create:
            self.root.mkdir(parents=True, exist_ok=True)
            if sys.platform != 'win32':
                self.root.chmod(0o700)
        self.server = self.root / 'server'
        self.uv = self.root / 'bin' / ('uv.exe' if sys.platform == 'win32' else 'uv')
        self.server_env = self.server / '.server-venv'
        self.engine_env = self.server / 'zotero-pdf2zh-next-venv'

    @staticmethod
    def python(environment):
        return Path(environment) / ('Scripts/python.exe' if sys.platform == 'win32' else 'bin/python')

    def _write(self, name, value):
        target = self.root / name
        temporary = target.with_suffix(target.suffix + '.tmp')
        temporary.write_text(json.dumps(value, ensure_ascii=True, indent=2) + '\n', encoding='utf-8')
        os.replace(temporary, target)

    def status(self, phase, message):
        self._write('status.json', {'phase': phase, 'message': message, 'version': VERSION, 'updated_at': time.time()})

    def _token(self, create=True):
        path = self.root / 'service-token'
        if not path.exists() and create:
            try:
                fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            except FileExistsError:
                pass
            else:
                with os.fdopen(fd, 'w', encoding='ascii') as stream:
                    stream.write(secrets.token_hex(32))
        try:
            token = path.read_text(encoding='ascii').strip()
        except (OSError, UnicodeError):
            raise RuntimeError('Local service identity is missing or unreadable.') from None
        if not re.fullmatch(r'[a-f0-9]{64}', token):
            raise RuntimeError('Local service identity is invalid; refusing automatic reset.')
        return token

    def environment(self):
        env = os.environ.copy()
        for key in ['PYTHONHOME', 'PYTHONPATH', 'VIRTUAL_ENV', 'CONDA_PREFIX']:
            env.pop(key, None)
        proxy = env.get('NO_PROXY', env.get('no_proxy', 'localhost,127.0.0.1,::1'))
        proxy = ','.join(part.strip() for part in proxy.split(',') if part.strip() and part.strip() != '[::1]')
        env.update(NO_PROXY=proxy, no_proxy=proxy, PYTHONUTF8='1', PYTHONUNBUFFERED='1', PYTHONNOUSERSITE='1',
                   GRADIO_ANALYTICS_ENABLED='False', UV_PYTHON_INSTALL_DIR=str(self.root / 'python'),
                   UV_CACHE_DIR=str(self.root / 'cache'), UV_NO_PROGRESS='1')
        env['PATH'] = str(self.root / 'bin') + os.pathsep + env.get('PATH', '')
        return env

    def installed(self):
        try:
            marker = json.loads((self.root / 'installation.json').read_text(encoding='utf-8'))
            return (isinstance(marker, dict) and marker.get('version') == VERSION
                    and marker.get('state', 'ready') == 'ready'
                    and marker.get('python', PYTHON_VERSION) == PYTHON_VERSION
                    and all(self.python(env).is_file() for env in (self.server_env, self.engine_env)))
        except (OSError, ValueError):
            return False

    def _execute(self, command, stage, timeout=900):
        self.status('installing', stage)
        with (self.root / 'install.log').open('ab', buffering=0) as log:
            quiet_run(command, cwd=str(self.root), env=self.environment(), stdin=-3,
                      stdout=log, stderr=-2, timeout=timeout, check=True)

    @contextmanager
    def _operation_lock(self, timeout):
        # Every mutator uses this order and one shared deadline. serve only takes
        # service.lock: taking launch.lock in the child would deadlock readiness.
        deadline = time.monotonic() + max(0, timeout)
        with file_lock(self.root / 'install.lock', max(0, deadline - time.monotonic())):
            with file_lock(self.root / 'launch.lock', max(0, deadline - time.monotonic())):
                yield

    def install(self, repair=False):
        with self._operation_lock(1):
            if self.installed() and not repair:
                self.status('installed', 'Translation engine is installed.')
                return
            # Exclude running and not-yet-listening servers before touching any
            # environment or ready marker. Older services are checked by proof.
            with file_lock(self.root / 'service.lock', 0):
                if bounded_read(time.monotonic() + 3, self._probe) or self._pid_alive(self._pending_record()):
                    raise RuntimeError('Local translation service is running; close it before installation or repair.')
                self._write('installation.json', {'version': None, 'state': 'repairing' if repair else 'installing'})
                try:
                    if not self.uv.is_file():
                        raise RuntimeError('Verified uv executable is missing.')
                    self._token()
                    for environment, requirements, stage in (
                        (self.server_env, 'requirements-server.txt', 'Installing local server dependencies'),
                        (self.engine_env, 'requirements-engine.txt', 'Installing translation engine dependencies'),
                    ):
                        # The pre-created server Python is executing bootstrap;
                        # rebuilding it in place fails with Windows sharing error 32.
                        if not self.python(environment).is_file():
                            self._execute([str(self.uv), 'venv', str(environment), '--allow-existing', '--managed-python', '--python', PYTHON_VERSION], 'Preparing isolated Python environment')
                        command = [str(self.uv), 'pip', 'install', '--python', str(self.python(environment)), '--index-url', 'https://pypi.org/simple', '-r', str(self.root / 'runtime' / requirements)]
                        if repair:
                            command.append('--reinstall')
                        self._execute(command, stage, 1200)
                    expected_python = tuple(int(part) for part in PYTHON_VERSION.split('.'))
                    version_check = f'import sys; assert sys.version_info[:3] == {expected_python!r}; '
                    self._execute([str(self.python(self.server_env)), '-I', '-c', version_check + 'import flask, fitz, pypdf, toml, packaging, psutil'], 'Checking server imports', 60)
                    self._execute([str(self.python(self.engine_env)), '-I', '-c', version_check + "from importlib.metadata import version; import pydantic_core._pydantic_core, fitz; assert version('pdf2zh-next') == '2.9.0'; assert version('BabelDOC') == '0.6.2'"], 'Checking engine imports', 90)
                    if not all(self.python(env).is_file() for env in (self.server_env, self.engine_env)):
                        raise RuntimeError('Managed Python interpreter is missing.')
                    self._write('installation.json', {'version': VERSION, 'python': PYTHON_VERSION, 'installed_at': time.time()})
                    self.status('installed', 'Translation engine is installed.')
                except Exception:
                    self.status('error', 'Translation engine installation failed. Retry or repair in settings.')
                    raise RuntimeError('Translation engine installation failed. Retry or repair in settings.') from None

    @staticmethod
    def _port_state():
        # Windows stealth/firewall policy can turn a truly empty port into an
        # HTTP timeout. Only a successful non-reusing bind proves it is free.
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
                if sys.platform == 'win32' and hasattr(socket, 'SO_EXCLUSIVEADDRUSE'):
                    probe.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
                try:
                    probe.bind(('127.0.0.1', PORT))
                except OSError as error:
                    if error.errno in (errno.EADDRINUSE, 10048) or getattr(error, 'winerror', None) == 10048:
                        return 'occupied'
                    if sys.platform == 'win32' and (error.errno in (errno.EACCES, 10013) or getattr(error, 'winerror', None) == 10013):
                        # Exclusive-bind conflicts and access restrictions share
                        # WSAEACCES. A proof may authorize reuse, never a launch.
                        return 'restricted'
                    raise
            return 'free'
        except OSError:
            raise RuntimeError('Local service port could not be verified.') from None

    def _probe(self):
        port_state = self._port_state()
        if port_state == 'free':
            return False
        nonce = secrets.token_hex(16)
        try:
            with OPENER.open(f'http://127.0.0.1:{PORT}/health?challenge={nonce}', timeout=2) as response:
                body = response.read(8193)
            if len(body) > 8192:
                raise RuntimeError('Local service identity response is too large.')
            data = json.loads(body)
        except (ValueError, OSError):
            raise RuntimeError('Local service health could not be verified.') from None
        expected = challenge_proof(self._token(create=False), nonce)
        if (not isinstance(data, dict) or data.get('service') != 'pdf2zh-easy'
                or data.get('runtime_version') != VERSION or not is_hex(data.get('proof'), 64)
                or not hmac.compare_digest(data['proof'], expected)):
            raise RuntimeError('Local service identity mismatch; refusing document submission.')
        return True

    def _service_busy(self):
        # Observational gate: never create/truncate a lock just to inspect it.
        try:
            handle = (self.root / 'service.lock').open('rb')
        except FileNotFoundError:
            return False
        with handle:
            try:
                if sys.platform == 'win32':
                    import msvcrt
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError as error:
                if error.errno in (errno.EACCES, errno.EAGAIN, errno.EDEADLK):
                    return True
                raise
            try:
                return False
            finally:
                if sys.platform == 'win32':
                    msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)

    def probe(self):
        deadline = time.monotonic() + 3
        if bounded_read(deadline, self._probe) or self._service_busy():
            return 0
        # A verified child may not have acquired its lifetime lock/listener yet.
        pending = self._pending_record(strict=True)
        return 0 if bounded_read(deadline, lambda: self._pid_alive(pending, strict=True)) else 3

    def _server_command(self):
        return [str(self.python(self.server_env)), '-X', 'utf8', '-u', str(self.root / 'runtime/bootstrap.py'), 'serve']

    def _process_record(self, pid):
        import psutil  # Installed with the server, never required for probe/bootstrap installation.
        try:
            created = psutil.Process(pid).create_time()
        except psutil.Error:
            raise RuntimeError('Local translation service exited or its identity could not be recorded.') from None
        return {'pid': pid, 'create_time': created,
                'exe': str(self.python(self.server_env).resolve()), 'argv': self._server_command()}

    def _pending_record(self, strict=False):
        try:
            return json.loads((self.root / 'server-pid.json').read_text(encoding='utf-8'))
        except FileNotFoundError:
            return None
        except (OSError, ValueError):
            if strict:
                raise RuntimeError('Local service pending identity could not be verified.') from None
            return None

    def _pid_alive(self, record, strict=False):
        # PID existence alone is not identity: PIDs are reused on every platform.
        # Legacy, malformed, reused or inaccessible records are never killed.
        if not isinstance(record, dict):
            return False
        pid, created = record.get('pid'), record.get('create_time')
        if (type(pid) is not int or not 0 < pid <= 0xffffffff
                or type(created) is not float or not math.isfinite(created) or created <= 0
                or record.get('exe') != str(self.python(self.server_env).resolve())
                or record.get('argv') != self._server_command()):
            return False
        try:
            import psutil
        except ImportError:
            if strict:
                raise RuntimeError('Local service pending identity could not be verified.') from None
            # A damaged environment must remain repairable. The proof check and
            # lifetime lock still exclude serving processes during installation.
            return False
        try:
            process = psutil.Process(pid)
            command = process.cmdline()
            if not isinstance(command, list) or len(command) != len(record['argv']):
                return False
            # POSIX venv interpreters can be symlinks; Windows paths are case-insensitive.
            command = list(command)
            command[0] = str(Path(command[0]).resolve())
            expected = list(record['argv'])
            expected[0] = record['exe']
            return (process.create_time() == created
                    and os.path.normcase(str(Path(process.exe()).resolve())) == os.path.normcase(record['exe'])
                    and command == expected
                    and process.is_running())
        except psutil.NoSuchProcess:
            return False
        except (psutil.Error, OSError, ValueError, TypeError):
            if strict:
                raise RuntimeError('Local service pending identity could not be verified.') from None
            return False

    def ensure(self, timeout=45):
        deadline = time.monotonic() + min(45, max(0, timeout))
        with self._operation_lock(max(0, deadline - time.monotonic())):
            # Check under the install lock; a repair may have invalidated readiness.
            if not self.installed():
                raise RuntimeError('Translation engine is not installed. Open settings to install it.')
            self._token(create=False)
            self.status('starting', 'Preparing local translation service')
            child = None
            while time.monotonic() < deadline:
                if bounded_read(deadline, self._probe):
                    self.status('ready', 'Local translation service is ready.')
                    return
                if child is None and not self._pid_alive(self._pending_record()):
                    # A child may already hold its lifetime lock before its PID
                    # record is available. Never start a duplicate in that window.
                    try:
                        with file_lock(self.root / 'service.lock', 0):
                            pass
                    except TimeoutError:
                        time.sleep(min(0.1, max(0, deadline - time.monotonic())))
                        continue
                    if bounded_read(deadline, self._probe):
                        continue
                    with (self.root / 'server.log').open('ab', buffering=0) as log:
                        child = quiet_popen(self._server_command(), cwd=str(self.root), env=self.environment(),
                                            stdin=-3, stdout=log, stderr=-2)
                    self._write('server-pid.json', self._process_record(child.pid))
                if child is not None and child.poll() is not None:
                    raise RuntimeError('Local translation service exited during startup.')
                time.sleep(min(0.1, max(0, deadline - time.monotonic())))
            raise RuntimeError('Local service readiness deadline exceeded; a pending service was left running.')

    def serve(self):
        # Keep this handle for the complete service lifetime, including imports.
        with file_lock(self.root / 'service.lock', 0), redacted_output():
            self._serve_locked()

    def _serve_locked(self):
        if not self.installed():
            raise RuntimeError('Translation engine is not installed.')
        token = self._token(create=False)
        register_secret(token)
        os.environ.update(self.environment())
        os.chdir(self.server)
        sys.path.insert(0, str(self.server))
        spec = importlib.util.spec_from_file_location('pdf2zh_easy_server', self.server / 'server.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        # Import instead of runpy __main__: no terminal prompts or update/news downloads.
        args = SimpleNamespace(host='127.0.0.1', port=PORT, enable_venv=True, env_tool='uv', check_update=False,
                               debug=False, enable_winexe=False, enable_mirror=False, mirror_source='https://pypi.org/simple',
                               winexe_path='', winexe_attach_console=False, skip_install=True, update_source='github')
        module.args = args
        module.prepare_path()
        translator = module.PDFTranslator(args)
        register_auth(translator.app, token, PORT)
        translator.run('127.0.0.1', PORT, debug=False)


def main():
    operation = sys.argv[1] if len(sys.argv) == 2 else ''
    runtime = ManagedRuntime(SOURCE_ROOT, create=operation != 'probe')
    try:
        if operation == 'probe':
            # Repair gates must be observational: no status/token writes or spawn.
            return runtime.probe()
        if operation == 'install':
            runtime.install()
        elif operation == 'repair':
            runtime.install(repair=True)
        elif operation == 'ensure':
            runtime.ensure()
        elif operation == 'serve':
            runtime.serve()
        else:
            raise RuntimeError('Unknown managed runtime operation.')
        return 0
    except Exception:
        if operation != 'probe':
            runtime.status('error', f'Managed runtime {operation or "operation"} failed. Check settings and retry.')
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
