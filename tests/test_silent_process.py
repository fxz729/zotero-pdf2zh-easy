"""Regression contract for a hidden Windows process chain and quiet POSIX spawn."""
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))


class SilentProcessTests(unittest.TestCase):
    @unittest.skipUnless(sys.platform == 'win32', 'Windows startup flags')
    def test_windows_console_children_have_no_window_and_hidden_startup(self):
        from utils.silent_process import quiet_options
        options = quiet_options('win32')
        self.assertTrue(options['creationflags'] & subprocess.CREATE_NO_WINDOW)
        self.assertTrue(options['startupinfo'].dwFlags & subprocess.STARTF_USESHOWWINDOW)
        self.assertEqual(options['startupinfo'].wShowWindow, subprocess.SW_HIDE)

    def test_posix_options_do_not_contain_windows_only_flags(self):
        from utils.silent_process import quiet_options
        for platform in ['linux', 'darwin']:
            self.assertEqual(quiet_options(platform), {'start_new_session': True})

    @unittest.skipUnless(sys.platform == 'win32', 'Windows startup flags')
    def test_returns_fresh_options_instead_of_mutable_shared_startup_info(self):
        from utils.silent_process import quiet_options
        a = quiet_options('win32')
        b = quiet_options('win32')
        self.assertIsNot(a['startupinfo'], b['startupinfo'])

    def test_popen_keeps_argument_arrays_and_always_uses_quiet_options(self):
        from utils.silent_process import popen
        command = ['C:/a b/python.exe', '中文 helper.py']
        with patch('utils.silent_process.subprocess.Popen') as spawn:
            popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            args, options = spawn.call_args
        self.assertIs(args[0], command)
        self.assertFalse(options.get('shell', False))
        self.assertEqual(options['stdout'], subprocess.PIPE)
        if sys.platform == 'win32':
            self.assertTrue(options['creationflags'] & subprocess.CREATE_NO_WINDOW)
        else:
            self.assertTrue(options['start_new_session'])

    def test_run_is_hidden_too_without_losing_timeout(self):
        from utils.silent_process import run
        with patch('utils.silent_process.subprocess.run') as spawn:
            run(['python.exe', '-V'], timeout=2, capture_output=True)
            _, options = spawn.call_args
        self.assertEqual(options['timeout'], 2)
        if sys.platform == 'win32':
            self.assertTrue(options['creationflags'] & subprocess.CREATE_NO_WINDOW)
        else:
            self.assertTrue(options['start_new_session'])

    @unittest.skipUnless(sys.platform == 'win32', 'Windows job flags')
    def test_only_owned_persistent_service_escapes_the_short_lived_gecko_job(self):
        from utils.silent_process import popen, service_popen
        with patch('utils.silent_process.subprocess.Popen') as spawn:
            service_popen(['python.exe', 'bootstrap.py', 'serve'])
            service_flags = spawn.call_args.kwargs['creationflags']
            popen(['uv.exe', 'pip', 'install'])
            installer_flags = spawn.call_args.kwargs['creationflags']
        self.assertTrue(service_flags & subprocess.CREATE_NO_WINDOW)
        self.assertTrue(service_flags & subprocess.CREATE_BREAKAWAY_FROM_JOB)
        self.assertFalse(installer_flags & subprocess.CREATE_BREAKAWAY_FROM_JOB)

    @unittest.skipUnless(sys.platform == 'win32', 'Windows startup flags')
    def test_caller_cannot_accidentally_request_a_new_console(self):
        from utils.silent_process import popen
        with self.assertRaises(ValueError):
            popen(['python.exe'], creationflags=subprocess.CREATE_NEW_CONSOLE)


if __name__ == '__main__':
    unittest.main()
