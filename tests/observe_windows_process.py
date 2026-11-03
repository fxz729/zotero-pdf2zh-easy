"""Opt-in Windows smoke test: observe only new visible console windows.

Uses a harmless short Python child as positive control; never opens documents or
records window titles. Run explicitly, not as part of the cross-platform suite.
"""
import ctypes
from ctypes import wintypes
import json
from pathlib import Path
import subprocess
import sys
import threading
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'server'))
from utils.silent_process import popen


def console_windows():
    user = ctypes.WinDLL('user32', use_last_error=True)
    user.IsWindowVisible.argtypes = [wintypes.HWND]
    user.IsWindowVisible.restype = wintypes.BOOL
    user.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    found = set()
    @callback_type
    def callback(hwnd, _):
        if user.IsWindowVisible(hwnd):
            name = ctypes.create_unicode_buffer(256)
            user.GetClassNameW(hwnd, name, len(name))
            if name.value in {'ConsoleWindowClass', 'CASCADIA_HOSTING_WINDOW_CLASS'}:
                found.add(int(hwnd))
        return True
    user.EnumWindows.argtypes = [callback_type, wintypes.LPARAM]
    user.EnumWindows(callback, 0)
    return found


def observe(spawn):
    existing = console_windows()
    seen = set()
    stop = threading.Event()
    def watch():
        while not stop.is_set():
            seen.update(console_windows() - existing)
            stop.wait(0.005)
    thread = threading.Thread(target=watch)
    thread.start()
    try:
        child = spawn([sys.executable, '-B', '-c', 'import time; time.sleep(0.7)'], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        code = child.wait(timeout=5)
        time.sleep(0.05)
    finally:
        stop.set()
        thread.join()
    return {'exit_code': code, 'new_visible_console_count': len(seen)}


def main():
    if sys.platform != 'win32':
        raise SystemExit('Windows-only manual observer')
    # The harness may already attach an invisible console, so an ordinary raw
    # spawn can inherit it. Force one visible console only in this positive
    # control to prove the observer can actually detect the defect class.
    before = observe(lambda command, **options: subprocess.Popen(command, creationflags=subprocess.CREATE_NEW_CONSOLE, **options))
    after = observe(popen)
    result = {
        'positive_control': before,
        'quiet_spawn': after,
        'proved_no_flash_for_controlled_child': before['new_visible_console_count'] > 0 and after['new_visible_console_count'] == 0 and after['exit_code'] == 0,
        'scope': 'Synthetic console child only; full Zotero startup and translation still require integration observation.',
    }
    out = ROOT / 'research/windows-process-observation.json'
    out.parent.mkdir(exist_ok=True)
    out.write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
