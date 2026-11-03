"""Observe one explicitly prepared disposable profile; never inspect user papers.

Starts before the desktop-shell launch. Captures no window titles or screen
contents. Cleans up only a HMAC-verified, idle service inside this test profile.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'server'))
from utils.silent_process import run as quiet_run
from observe_windows_process import console_windows
import psutil


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('preparation')
    parser.add_argument('--timeout', type=int, default=2400)
    args = parser.parse_args()
    preparation = Path(args.preparation).resolve()
    receipt = json.loads(preparation.read_text(encoding='utf-8'))
    profile = Path(receipt['profile']).resolve()
    if not receipt.get('test_only') or receipt.get('provider_credentials_copied') is not False or profile.parent.parent != ROOT / 'research':
        raise RuntimeError('Refusing an unrelated or credential-bearing profile.')
    report_path = profile.parent / 'native-result.json'
    outcome = {'test_only': True, 'started_at': time.time(), 'ok': False}
    baseline = console_windows()
    observed = set()
    stop = threading.Event()
    def watch():
        while not stop.is_set():
            observed.update(console_windows() - baseline)
            stop.wait(0.01)
    observer = threading.Thread(target=watch, daemon=True)
    observer.start()
    native = None
    deadline = time.monotonic() + args.timeout
    try:
        while time.monotonic() < deadline:
            try:
                native = json.loads(report_path.read_text(encoding='utf-8'))
                if native.get('finishedAt'):
                    break
            except (OSError, ValueError):
                pass
            time.sleep(0.5)
        if not native or not native.get('finishedAt'):
            raise RuntimeError('Native test did not finish before its deadline.')
        outcome['native_ok'] = bool(native.get('ok'))
        # Let only our disposable Zotero profile exit naturally.
        close_deadline = time.monotonic() + 20
        while time.monotonic() < close_deadline:
            owned = []
            for process in psutil.process_iter(['name', 'cmdline']):
                try:
                    if (process.info['name'] or '').lower() == 'zotero.exe' and str(profile) in (process.info['cmdline'] or []):
                        owned.append(process.pid)
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    pass
            if not owned:
                break
            time.sleep(0.2)
        outcome['test_zotero_exited'] = not owned
        if not native.get('ok'):
            raise RuntimeError('Native test failed: ' + str(native.get('error', 'No successful result'))[:220])
        root = Path(native.get('runtimeRoot', '')).resolve()
        if not root.is_relative_to(profile) or not root.name.startswith('runtime-0.1.0-'):
            raise RuntimeError('Unexpected managed runtime path; refusing external execution.')
        helper = root / 'runtime/bootstrap.py'
        manifest = json.loads((ROOT / 'plugin/addon/content/runtime/runtime-manifest.json').read_text(encoding='utf-8'))
        expected = next(entry['sha256'] for entry in manifest['files'] if entry['path'] == 'runtime/bootstrap.py')
        if hashlib.sha256(helper.read_bytes()).hexdigest() != expected:
            raise RuntimeError('Test helper differs from reviewed build; refusing execution.')
        python = root / 'server/.server-venv/Scripts/python.exe'
        probe = quiet_run([str(python), '-X', 'utf8', '-u', str(helper), 'probe'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
        outcome['service_alive_after_zotero_exit'] = probe.returncode == 0
        if probe.returncode == 0:
            token = (root / 'service-token').read_text(encoding='ascii').strip()
            request = urllib.request.Request('http://127.0.0.1:8891/api/tasks', headers={'X-PDF2zh-Easy-Token': token})
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            with opener.open(request, timeout=3) as response:
                tasks = json.loads(response.read(8192)).get('tasks')
            if tasks != []:
                raise RuntimeError('Test service has active tasks; refusing cleanup.')
            listeners = [entry.pid for entry in psutil.net_connections(kind='tcp') if entry.laddr.port == 8891 and entry.status == psutil.CONN_LISTEN]
            if len(set(listeners)) != 1:
                raise RuntimeError('Ambiguous test service listener; refusing cleanup.')
            server = psutil.Process(listeners[0])
            command = server.cmdline()
            if len(command) != 6 or Path(command[4]).resolve() != helper or command[5] != 'serve' or not Path(server.exe()).resolve().is_relative_to(root):
                raise RuntimeError('Unexpected test process identity; refusing cleanup.')
            server.terminate()
            server.wait(timeout=10)
            outcome['owned_idle_test_service_stopped'] = True
        outcome['ok'] = bool(native.get('ok') and outcome['test_zotero_exited'] and outcome['service_alive_after_zotero_exit'])
    except Exception as error:
        outcome['error'] = str(error)[:300]
    finally:
        stop.set()
        observer.join(timeout=2)
        outcome['new_visible_console_count'] = len(observed)
        outcome['ok'] = bool(outcome['ok'] and not observed)
        outcome['finished_at'] = time.time()
        (profile.parent / 'watcher-result.json').write_text(json.dumps(outcome, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(outcome))
    return 0 if outcome['ok'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
