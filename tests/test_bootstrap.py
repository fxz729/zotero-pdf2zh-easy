from contextlib import contextmanager
import ast
import errno
import importlib
import json
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


class BootstrapTests(unittest.TestCase):
    def setUp(self):
        self.module = importlib.import_module('runtime.bootstrap')
        self.directory = tempfile.TemporaryDirectory(prefix='pdf2zh-easy-')
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.runtime = self.module.ManagedRuntime(self.root)
        self.runtime.uv.parent.mkdir(parents=True, exist_ok=True)
        self.runtime.uv.touch()
        # Never bind a real user port. Default to a demonstrably free mock port.
        self.port_socket = Mock()
        self.port_socket.__enter__ = Mock(return_value=self.port_socket)
        def close_socket(*args):
            self.port_socket.close()
            return False
        self.port_socket.__exit__ = Mock(side_effect=close_socket)
        self.socket_factory = self.enterContext(patch('socket.socket', return_value=self.port_socket))
        # Every health request is offline unless a test provides a fake response.
        self.opener = self.enterContext(patch.object(
            self.module.OPENER, 'open',
            side_effect=self.module.urllib.error.URLError(OSError(errno.ECONNREFUSED, 'refused'))))

    def mark_installed(self):
        for env in [self.runtime.server_env, self.runtime.engine_env]:
            path = self.runtime.python(env)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.touch()
        self.runtime._token()
        self.runtime._write('installation.json', {'version': self.module.VERSION})

    def test_environment_is_private_and_does_not_inherit_python_injection(self):
        with patch.dict('os.environ', {'PYTHONPATH': '/unrelated', 'PYTHONHOME': '/other', 'NO_PROXY': '[::1],localhost'}):
            env = self.runtime.environment()
        self.assertNotIn('PYTHONPATH', env)
        self.assertNotIn('PYTHONHOME', env)
        self.assertEqual(env['NO_PROXY'], 'localhost')
        self.assertEqual(env['UV_PYTHON_INSTALL_DIR'], str(self.root / 'python'))
        self.assertIn(str(self.root / 'bin'), env['PATH'])

    def test_token_is_persistent_and_never_appears_in_status(self):
        token = self.runtime._token()
        self.assertEqual(len(token), 64)
        self.assertEqual(token, self.runtime._token())
        self.runtime.status('ready', 'Ready')
        self.assertNotIn(token, (self.root / 'status.json').read_text())

    def test_corrupt_existing_identity_fails_instead_of_resetting(self):
        (self.root / 'service-token').write_text('not a token')
        with self.assertRaisesRegex(RuntimeError, 'identity'):
            self.runtime._token()

    def test_install_uses_pinned_requirement_files_and_marks_ready_only_at_end(self):
        calls = []
        def execute(command, stage, timeout=900):
            marker = json.loads((self.root / 'installation.json').read_text())
            self.assertIsNone(marker['version'])
            self.assertFalse(self.runtime.installed())
            calls.append(command)
            if command[1] == 'venv':
                interpreter = self.runtime.python(Path(command[2]))
                interpreter.parent.mkdir(parents=True, exist_ok=True)
                interpreter.touch()
        with patch.object(self.runtime, '_execute', side_effect=execute):
            self.runtime.install()
        self.assertEqual(json.loads((self.root / 'installation.json').read_text())['version'], self.module.VERSION)
        self.assertEqual(sum(command[1] == 'venv' for command in calls), 2)
        self.assertTrue(all('--managed-python' in command for command in calls if command[1] == 'venv'))
        requirement_paths = [command[command.index('-r') + 1] for command in calls if '-r' in command]
        self.assertTrue(any(path.endswith('requirements-server.txt') for path in requirement_paths))
        self.assertTrue(any(path.endswith('requirements-engine.txt') for path in requirement_paths))

    def test_precreated_bootstrap_python_is_not_overwritten_but_engine_and_dependencies_are_installed(self):
        interpreter = self.runtime.python(self.runtime.server_env)
        interpreter.parent.mkdir(parents=True, exist_ok=True)
        interpreter.write_bytes(b'synthetic running bootstrap interpreter')
        calls = []
        def execute(command, stage, timeout=900):
            calls.append(command)
            if command[1] == 'venv':
                path = self.runtime.python(Path(command[2]))
                path.parent.mkdir(parents=True, exist_ok=True)
                path.touch()
        with patch.object(self.runtime, '_execute', side_effect=execute):
            self.runtime.install()
        self.assertEqual([command[2] for command in calls if command[1] == 'venv'], [str(self.runtime.engine_env)])
        self.assertEqual(interpreter.read_bytes(), b'synthetic running bootstrap interpreter')
        pip = [command for command in calls if command[1:3] == ['pip', 'install']]
        self.assertEqual(len(pip), 2)
        self.assertEqual({command[command.index('--python') + 1] for command in pip},
                         {str(self.runtime.python(env)) for env in (self.runtime.server_env, self.runtime.engine_env)})
        checks = [command for command in calls if '-c' in command]
        self.assertEqual(len(checks), 2)
        self.assertTrue(self.runtime.installed())

    def test_existing_both_environments_skip_venv_but_repair_still_reinstalls_dependencies(self):
        self.mark_installed()
        with patch.object(self.runtime, '_execute') as execute:
            self.runtime.install(repair=True)
        commands = [call.args[0] for call in execute.call_args_list]
        self.assertFalse(any(command[1] == 'venv' for command in commands))
        pip = [command for command in commands if command[1:3] == ['pip', 'install']]
        self.assertEqual(len(pip), 2)
        self.assertTrue(all('--reinstall' in command for command in pip))
        self.assertEqual(sum('-c' in command for command in commands), 2)

    def test_both_environment_import_checks_assert_the_actual_pinned_python_version(self):
        self.mark_installed()
        with patch.object(self.runtime, '_execute') as execute:
            self.runtime.install(repair=True)
        checks = [call.args[0] for call in execute.call_args_list if '-c' in call.args[0]]
        self.assertEqual(len(checks), 2)
        for command in checks:
            with self.subTest(interpreter=command[0]):
                self.assertIn('-I', command)
                code = command[command.index('-c') + 1]
                assertions = [node for node in ast.walk(ast.parse(code))
                              if isinstance(node, ast.Assert) and 'sys.version_info' in ast.unparse(node.test)]
                self.assertEqual(len(assertions), 1)
                check = compile(ast.Module(body=assertions, type_ignores=[]), '<synthetic-python-version-check>', 'exec')
                exec(check, {'sys': SimpleNamespace(version_info=(3, 12, 13, 'final', 0))})
                with self.assertRaises(AssertionError):
                    exec(check, {'sys': SimpleNamespace(version_info=(3, 12, 12, 'final', 0))})

    def test_wrong_actual_version_in_either_environment_never_publishes_ready(self):
        self.mark_installed()
        for wrong in (self.runtime.server_env, self.runtime.engine_env):
            with self.subTest(environment=wrong):
                self.runtime._write('installation.json', {'version': self.module.VERSION})
                def execute(command, stage, timeout=900):
                    if command[0] != str(self.runtime.python(wrong)) or '-c' not in command:
                        return
                    code = command[command.index('-c') + 1]
                    assertions = [node for node in ast.walk(ast.parse(code))
                                  if isinstance(node, ast.Assert) and 'sys.version_info' in ast.unparse(node.test)]
                    check = compile(ast.Module(body=assertions, type_ignores=[]), '<synthetic-python-version-check>', 'exec')
                    exec(check, {'sys': SimpleNamespace(version_info=(3, 11, 9, 'final', 0))})
                with patch.object(self.runtime, '_execute', side_effect=execute):
                    with self.assertRaisesRegex(RuntimeError, 'installation failed'):
                        self.runtime.install(repair=True)
                self.assertFalse(self.runtime.installed())
                self.assertIsNone(json.loads((self.root / 'installation.json').read_text())['version'])

    def test_failed_install_has_no_ready_marker_and_no_stderr_in_status(self):
        with patch.object(self.runtime, '_execute', side_effect=subprocess.CalledProcessError(1, ['uv'], stderr='private-key')):
            with self.assertRaisesRegex(RuntimeError, 'installation failed'):
                self.runtime.install()
        self.assertFalse(self.runtime.installed())
        marker = json.loads((self.root / 'installation.json').read_text())
        self.assertIsNone(marker['version'])
        status = (self.root / 'status.json').read_text()
        self.assertIn('error', status)
        self.assertNotIn('private-key', status)

    def test_already_installed_environment_is_reused_without_pip(self):
        self.mark_installed()
        with patch.object(self.runtime, '_execute') as execute:
            self.runtime.install()
        execute.assert_not_called()

    def test_ready_authenticated_server_is_reused_without_spawn(self):
        self.mark_installed()
        with patch.object(self.runtime, '_probe', return_value=True), patch.object(self.module, 'quiet_popen') as spawn:
            self.runtime.ensure(timeout=1)
        spawn.assert_not_called()
        self.assertEqual(json.loads((self.root / 'status.json').read_text())['phase'], 'ready')

    def test_unidentified_listener_never_authorizes_launch_or_submission(self):
        self.mark_installed()
        with patch.object(self.runtime, '_probe', side_effect=RuntimeError('Local service identity mismatch.')), patch.object(self.module, 'quiet_popen') as spawn:
            with self.assertRaisesRegex(RuntimeError, 'identity'):
                self.runtime.ensure(timeout=1)
        spawn.assert_not_called()

    def test_new_server_is_started_once_and_pid_persisted(self):
        self.mark_installed()
        child = Mock(pid=12345)
        child.poll.return_value = None
        process = Mock()
        process.create_time.return_value = 123.5
        with patch('psutil.Process', return_value=process), patch.object(self.runtime, '_probe', side_effect=[False, False, True]), patch.object(self.module, 'quiet_popen', return_value=child) as spawn:
            self.runtime.ensure(timeout=1)
        self.assertEqual(spawn.call_count, 1)
        self.assertEqual(json.loads((self.root / 'server-pid.json').read_text())['pid'], 12345)
        self.assertNotIn(self.runtime._token(), str(spawn.call_args.args))

    def test_pending_live_process_is_waited_not_duplicated_on_timeout(self):
        self.mark_installed()
        self.runtime._write('server-pid.json', {'pid': 12345})
        with patch.object(self.runtime, '_probe', return_value=False), patch.object(self.runtime, '_pid_alive', return_value=True), patch.object(self.module, 'quiet_popen') as spawn:
            with self.assertRaisesRegex(RuntimeError, 'deadline'):
                self.runtime.ensure(timeout=0.03)
        spawn.assert_not_called()
        self.assertEqual(json.loads((self.root / 'server-pid.json').read_text())['pid'], 12345)

    def test_not_installed_cannot_start_service(self):
        with patch.object(self.module, 'quiet_popen') as spawn:
            with self.assertRaisesRegex(RuntimeError, 'not installed'):
                self.runtime.ensure()
        spawn.assert_not_called()

    def test_real_file_lock_is_exclusive_and_released(self):
        path = self.root / 'test.lock'
        with self.module.file_lock(path, 1):
            with self.assertRaisesRegex(TimeoutError, 'lock'):
                with self.module.file_lock(path, 0.02):
                    pass
        with self.module.file_lock(path, 0.1):
            pass

    def test_non_object_installation_markers_are_not_installed(self):
        self.mark_installed()
        for marker in ([], None, 123, 'ready', {'version': self.module.VERSION, 'state': 'installing'}):
            with self.subTest(marker=marker):
                self.runtime._write('installation.json', marker)
                self.assertFalse(self.runtime.installed())

    def test_failed_recovery_cannot_reactivate_old_ready_marker(self):
        self.mark_installed()
        interpreter = self.runtime.python(self.runtime.engine_env)
        interpreter.unlink()
        def fail_after_recreating_interpreter(*args):
            interpreter.touch()
            raise RuntimeError('dependency failure')
        with patch.object(self.runtime, '_execute', side_effect=fail_after_recreating_interpreter):
            with self.assertRaisesRegex(RuntimeError, 'installation failed'):
                self.runtime.install()
        self.assertFalse(self.runtime.installed())

    def test_repair_rejects_authenticated_service_before_mutating_marker(self):
        self.mark_installed()
        marker = (self.root / 'installation.json').read_bytes()
        with patch.object(self.runtime, '_probe', return_value=True), patch.object(self.runtime, '_execute') as execute:
            with self.assertRaisesRegex(RuntimeError, 'running'):
                self.runtime.install(repair=True)
        execute.assert_not_called()
        self.assertEqual(marker, (self.root / 'installation.json').read_bytes())

    def test_repair_rejects_held_service_lifetime_lock(self):
        self.mark_installed()
        marker = (self.root / 'installation.json').read_bytes()
        with self.module.file_lock(self.root / 'service.lock', 1), patch.object(self.runtime, '_execute') as execute:
            with self.assertRaises(TimeoutError):
                self.runtime.install(repair=True)
        execute.assert_not_called()
        self.assertEqual(marker, (self.root / 'installation.json').read_bytes())

    def test_ensure_cannot_race_an_install(self):
        self.mark_installed()
        with self.module.file_lock(self.root / 'install.lock', 1), patch.object(self.runtime, '_probe', return_value=True), patch.object(self.module, 'quiet_popen') as spawn:
            with self.assertRaises(TimeoutError):
                self.runtime.ensure(timeout=0.03)
        spawn.assert_not_called()

    def test_ensure_and_install_use_same_lock_order(self):
        self.mark_installed()
        paths = []
        real_lock = self.module.file_lock
        @contextmanager
        def track(path, timeout):
            paths.append(Path(path).name)
            with real_lock(path, timeout):
                yield
        with patch.object(self.module, 'file_lock', side_effect=track), patch.object(self.runtime, '_probe', return_value=True):
            self.runtime.ensure(timeout=1)
        self.assertEqual(paths[:2], ['install.lock', 'launch.lock'])
        paths.clear()
        with patch.object(self.module, 'file_lock', side_effect=track):
            self.runtime.install()
        self.assertEqual(paths[:2], ['install.lock', 'launch.lock'])

    def test_serve_holds_lifetime_lock_before_import_and_until_exit(self):
        self.mark_installed()
        def assert_locked(*args, **kwargs):
            with self.assertRaises(TimeoutError):
                with self.module.file_lock(self.root / 'service.lock', 0):
                    pass
        module = Mock()
        spec = Mock()
        spec.loader.exec_module.side_effect = assert_locked
        module.PDFTranslator.return_value.run.side_effect = assert_locked
        with patch.object(self.runtime, 'environment', return_value={}), patch.object(self.module.os, 'chdir'), patch.object(self.module.importlib.util, 'spec_from_file_location', return_value=spec), patch.object(self.module.importlib.util, 'module_from_spec', return_value=module), patch.object(self.module, 'register_auth'):
            self.runtime.serve()
        spec.loader.exec_module.assert_called_once()
        module.PDFTranslator.return_value.run.assert_called_once()
        with self.module.file_lock(self.root / 'service.lock', 0):
            pass

    def test_pending_process_is_rechecked_and_replaced_after_exit(self):
        self.mark_installed()
        self.runtime._write('server-pid.json', {'pid': 12345})
        process = Mock()
        process.create_time.return_value = 123.5
        child = Mock(pid=12346)
        child.poll.return_value = None
        with patch('psutil.Process', return_value=process), patch.object(self.runtime, '_pid_alive', side_effect=[True, False]) as alive, patch.object(self.runtime, '_probe', side_effect=[False, False, False, True]), patch.object(self.module, 'quiet_popen', return_value=child) as spawn:
            self.runtime.ensure(timeout=1)
        self.assertEqual(alive.call_count, 2)
        spawn.assert_called_once()

    def test_unknown_pid_with_held_lifetime_lock_is_waited_without_spawn(self):
        self.mark_installed()
        self.runtime._write('server-pid.json', {'pid': 12345})
        with self.module.file_lock(self.root / 'service.lock', 0), patch.object(self.runtime, '_probe', return_value=False), patch.object(self.module, 'quiet_popen') as spawn:
            with self.assertRaisesRegex(RuntimeError, 'deadline'):
                self.runtime.ensure(timeout=0.03)
        spawn.assert_not_called()

    def test_repair_rejects_pending_identity_before_mutating_marker(self):
        self.mark_installed()
        marker = (self.root / 'installation.json').read_bytes()
        with patch.object(self.runtime, '_pid_alive', return_value=True), patch.object(self.runtime, '_execute') as execute:
            with self.assertRaisesRegex(RuntimeError, 'running'):
                self.runtime.install(repair=True)
        execute.assert_not_called()
        self.assertEqual(marker, (self.root / 'installation.json').read_bytes())

    def test_corrupt_marker_can_be_repaired(self):
        self.mark_installed()
        self.runtime._write('installation.json', [])
        with patch.object(self.runtime, '_execute'):
            self.runtime.install(repair=True)
        self.assertTrue(self.runtime.installed())

    def test_service_import_failure_releases_lifetime_lock(self):
        self.mark_installed()
        spec = Mock()
        spec.loader.exec_module.side_effect = RuntimeError('import failed')
        with patch.object(self.runtime, 'environment', return_value={}), patch.object(self.module.os, 'chdir'), patch.object(self.module.importlib.util, 'spec_from_file_location', return_value=spec), patch.object(self.module.importlib.util, 'module_from_spec', return_value=Mock()):
            with self.assertRaisesRegex(RuntimeError, 'import failed'):
                self.runtime.serve()
        with self.module.file_lock(self.root / 'service.lock', 0):
            pass

    def test_probe_constructor_does_not_create_or_chmod_root(self):
        with patch.object(Path, 'mkdir') as mkdir, patch.object(Path, 'chmod') as chmod:
            runtime = self.module.ManagedRuntime(self.root / 'absent', create=False)
        mkdir.assert_not_called()
        chmod.assert_not_called()
        self.assertFalse(runtime.root.exists())
        with patch.object(self.module.sys, 'argv', ['bootstrap.py', 'probe']), patch.object(self.module, 'ManagedRuntime', return_value=self.runtime) as constructor, patch.object(self.runtime, '_probe', return_value=False):
            self.assertEqual(self.module.main(), 3)
        constructor.assert_called_once_with(self.module.SOURCE_ROOT, create=False)

    def test_bounded_read_enforces_deadline_for_stalled_probe(self):
        event = self.module.threading.Event()
        try:
            with self.assertRaisesRegex(RuntimeError, 'deadline'):
                self.module.bounded_read(self.module.time.monotonic() + 0.02, lambda: event.wait(1))
        finally:
            event.set()

    def process_record(self):
        return {'pid': 12345, 'create_time': 123.5,
                'exe': str(self.runtime.python(self.runtime.server_env).resolve()),
                'argv': [str(self.runtime.python(self.runtime.server_env)), '-X', 'utf8', '-u', str(self.root / 'runtime/bootstrap.py'), 'serve']}

    def test_pid_identity_requires_creation_time_executable_and_argv(self):
        record = self.process_record()
        process = Mock()
        process.create_time.return_value = record['create_time']
        process.exe.return_value = record['exe']
        process.cmdline.return_value = record['argv']
        with patch('psutil.Process', return_value=process):
            self.assertTrue(self.runtime._pid_alive(record))
            for method, wrong in [('create_time', 456.0), ('exe', '/other/python'), ('cmdline', ['unrelated'])]:
                with self.subTest(method=method):
                    getter = getattr(process, method)
                    old = getter.return_value
                    getter.return_value = wrong
                    self.assertFalse(self.runtime._pid_alive(record))
                    getter.return_value = old
            for bad in ({'pid': 12345}, {**record, 'pid': True}, {**record, 'create_time': float('nan')}, {**record, 'create_time': 10 ** 1000}, []):
                self.assertFalse(self.runtime._pid_alive(bad))

    def test_reused_or_unreadable_pid_is_ignored_without_termination(self):
        import psutil
        record = self.process_record()
        for error in (psutil.NoSuchProcess(12345), psutil.AccessDenied(12345)):
            with self.subTest(error=type(error).__name__), patch('psutil.Process', side_effect=error):
                self.assertFalse(self.runtime._pid_alive(record))

    def test_missing_psutil_in_broken_environment_does_not_prevent_repair(self):
        self.mark_installed()
        self.runtime._write('server-pid.json', self.process_record())
        with patch.dict(sys.modules, {'psutil': None}), patch.object(self.runtime, '_execute'):
            self.runtime.install(repair=True)
        self.assertTrue(self.runtime.installed())

    def test_recorded_child_has_os_creation_time_and_expected_identity(self):
        process = Mock()
        process.create_time.return_value = 123.5
        with patch('psutil.Process', return_value=process):
            self.assertEqual(self.runtime._process_record(12345), self.process_record())

    def test_invalid_proof_values_are_rejected_without_coercion(self):
        self.mark_installed()
        self.port_socket.bind.side_effect = OSError(errno.EADDRINUSE, 'occupied')
        nonce = '01' * 16
        token = self.runtime._token()
        proof = self.module.challenge_proof(token, nonce)
        response = Mock()
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        self.opener.side_effect = None
        self.opener.return_value = response
        for value in (None, [], {}, 123, 'é', '中', 'a' * 65):
            with self.subTest(value=value), patch.object(self.module.secrets, 'token_hex', return_value=nonce):
                response.read.return_value = json.dumps({'service': 'pdf2zh-easy', 'runtime_version': self.module.VERSION, 'proof': value}).encode()
                with self.assertRaisesRegex(RuntimeError, 'identity'):
                    self.runtime._probe()
        with patch.object(self.module.secrets, 'token_hex', return_value=nonce):
            response.read.return_value = json.dumps({'service': 'pdf2zh-easy', 'runtime_version': self.module.VERSION, 'proof': proof}).encode()
            self.assertTrue(self.runtime._probe())

    def authenticated_response(self):
        nonce = '01' * 16
        proof = self.module.challenge_proof(self.runtime._token(), nonce)
        response = Mock()
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        response.read.return_value = json.dumps({'service': 'pdf2zh-easy', 'runtime_version': self.module.VERSION, 'proof': proof}).encode()
        self.opener.side_effect = None
        self.opener.return_value = response
        return nonce

    def test_free_windows_port_uses_exclusive_bind_without_http_or_identity_writes(self):
        self.opener.side_effect = self.module.urllib.error.URLError(TimeoutError('synthetic stealth timeout'))
        before = set(self.root.iterdir())
        with patch.object(self.module.sys, 'platform', 'win32'), patch.object(socket, 'SO_EXCLUSIVEADDRUSE', 98765, create=True):
            self.assertFalse(self.runtime._probe())
        self.socket_factory.assert_called_once_with(socket.AF_INET, socket.SOCK_STREAM)
        self.port_socket.setsockopt.assert_called_once_with(socket.SOL_SOCKET, 98765, 1)
        self.port_socket.bind.assert_called_once_with(('127.0.0.1', self.module.PORT))
        self.port_socket.listen.assert_not_called()
        self.port_socket.close.assert_called_once()
        self.opener.assert_not_called()
        self.assertEqual(set(self.root.iterdir()), before)
        self.assertFalse((self.root / 'service-token').exists())

    def test_free_posix_port_uses_plain_bind_without_reuse_or_windows_flags(self):
        for platform in ('linux', 'darwin'):
            with self.subTest(platform=platform), patch.object(self.module.sys, 'platform', platform):
                self.assertFalse(self.runtime._probe())
        self.assertEqual(self.port_socket.bind.call_count, 2)
        self.assertEqual(self.port_socket.close.call_count, 2)
        self.port_socket.setsockopt.assert_not_called()
        self.opener.assert_not_called()

    def test_occupied_port_closes_probe_socket_then_still_requires_hmac_proof(self):
        self.port_socket.bind.side_effect = OSError(errno.EADDRINUSE, 'occupied')
        nonce = self.authenticated_response()
        def opened(*args, **kwargs):
            self.port_socket.close.assert_called_once()
            return self.opener.return_value
        self.opener.side_effect = opened
        with patch.object(self.module.secrets, 'token_hex', return_value=nonce):
            self.assertTrue(self.runtime._probe())
        self.opener.assert_called_once()

    def test_windows_address_in_use_error_still_checks_service_proof(self):
        self.port_socket.bind.side_effect = OSError(10048, 'synthetic occupied')
        nonce = self.authenticated_response()
        with patch.object(self.module.sys, 'platform', 'win32'), patch.object(self.module.secrets, 'token_hex', return_value=nonce):
            self.assertTrue(self.runtime._probe())
        self.opener.assert_called_once()
        self.port_socket.close.assert_called_once()

    def test_occupied_http_errors_never_authorize_start_or_become_free(self):
        self.mark_installed()
        self.port_socket.bind.side_effect = OSError(errno.EADDRINUSE, 'occupied')
        for reason in (TimeoutError('synthetic-private-timeout'), OSError(errno.ECONNREFUSED, 'synthetic-private-refused')):
            with self.subTest(reason=type(reason).__name__):
                self.opener.side_effect = self.module.urllib.error.URLError(reason)
                with patch.object(self.module, 'quiet_popen') as spawn:
                    with self.assertRaisesRegex(RuntimeError, 'health') as failure:
                        self.runtime.ensure(timeout=0.1)
                self.assertNotIn('synthetic-private', str(failure.exception))
                spawn.assert_not_called()
        self.assertEqual(self.port_socket.close.call_count, 2)

    def test_other_bind_failures_fail_closed_without_http_or_spawn(self):
        self.mark_installed()
        for code in (errno.EACCES, errno.EADDRNOTAVAIL, errno.EINVAL):
            with self.subTest(code=code), patch.object(self.module.sys, 'platform', 'linux'), patch.object(self.module, 'quiet_popen') as spawn:
                self.port_socket.bind.side_effect = OSError(code, 'synthetic-private-bind-error')
                with self.assertRaisesRegex(RuntimeError, 'port|health') as failure:
                    self.runtime._probe()
                self.assertNotIn('synthetic-private', str(failure.exception))
                spawn.assert_not_called()
        self.port_socket.bind.side_effect = OSError(errno.EADDRNOTAVAIL, 'synthetic-private-bind-error')
        with patch.object(self.module, 'quiet_popen') as spawn:
            with self.assertRaisesRegex(RuntimeError, 'port|health'):
                self.runtime.ensure(timeout=0.1)
        spawn.assert_not_called()
        self.opener.assert_not_called()
        self.assertEqual(self.port_socket.close.call_count, 4)

    def test_socket_creation_and_exclusive_option_failures_are_not_free(self):
        self.socket_factory.side_effect = OSError(errno.EMFILE, 'synthetic-private-socket-create')
        with self.assertRaisesRegex(RuntimeError, 'port|health'):
            self.runtime._probe()
        self.port_socket.close.assert_not_called()
        self.socket_factory.side_effect = None
        self.port_socket.setsockopt.side_effect = OSError(errno.EACCES, 'synthetic-private-socket-option')
        with patch.object(self.module.sys, 'platform', 'win32'), patch.object(socket, 'SO_EXCLUSIVEADDRUSE', 98765, create=True):
            with self.assertRaisesRegex(RuntimeError, 'port|health'):
                self.runtime._probe()
        self.port_socket.bind.assert_not_called()
        self.port_socket.close.assert_called_once()
        self.opener.assert_not_called()

    def test_windows_restricted_bind_can_only_reuse_authenticated_service_not_claim_idle(self):
        self.port_socket.bind.side_effect = OSError(10013, 'synthetic ambiguous exclusive conflict')
        nonce = self.authenticated_response()
        with patch.object(self.module.sys, 'platform', 'win32'), patch.object(self.module.secrets, 'token_hex', return_value=nonce):
            self.assertTrue(self.runtime._probe())
        self.opener.side_effect = self.module.urllib.error.URLError(OSError(errno.ECONNREFUSED, 'refused'))
        with patch.object(self.module.sys, 'platform', 'win32'):
            with self.assertRaisesRegex(RuntimeError, 'port|health'):
                self.runtime._probe()
        self.assertEqual(self.port_socket.close.call_count, 2)

    def test_free_port_does_not_override_lifetime_lock_or_pending_identity_idle_gate(self):
        before = set(self.root.iterdir())
        with patch.object(self.runtime, '_pid_alive', return_value=True):
            self.assertEqual(self.runtime.probe(), 0)
        self.assertEqual(set(self.root.iterdir()), before)
        with self.module.file_lock(self.root / 'service.lock', 0):
            self.assertEqual(self.runtime.probe(), 0)
        self.opener.assert_not_called()
        self.assertFalse((self.root / 'status.json').exists())
        self.assertFalse((self.root / 'service-token').exists())

    def test_probe_command_only_returns_exit_codes_and_never_changes_status(self):
        for result, expected in ((True, 0), (False, 3), (RuntimeError('identity mismatch'), 1)):
            with self.subTest(result=result):
                kwargs = {'side_effect': result} if isinstance(result, Exception) else {'return_value': result}
                with patch.object(self.module.sys, 'argv', ['bootstrap.py', 'probe']), patch.object(self.module, 'ManagedRuntime', return_value=self.runtime), patch.object(self.runtime, '_probe', **kwargs), patch.object(self.runtime, 'status') as status, patch.object(self.module, 'quiet_popen') as spawn:
                    self.assertEqual(self.module.main(), expected)
                status.assert_not_called()
                spawn.assert_not_called()
                self.assertFalse((self.root / 'service-token').exists())


if __name__ == '__main__':
    unittest.main()
