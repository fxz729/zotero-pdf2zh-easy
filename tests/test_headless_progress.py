"""Run with the translation venv's Python -B; no translation/API calls."""
import contextlib
import importlib.util
import io
import os
from pathlib import Path
import subprocess
import sys
import types
import unittest
from unittest.mock import Mock, patch


SOURCE = Path(__file__).resolve().parents[1] / "server/utils/execute.py"
sys.path.insert(0, str(SOURCE.parents[1]))
ENGINE_PYTHON = Path(sys.executable)


def load_execute():
    # Isolate server dependencies so tests cannot mutate live task state or config.
    dependencies = {
        "utils.deepseek_thinking": {"prepare_deepseek_runtime_command": lambda cmd, env: cmd},
        "utils.environment_lifecycle": {"managed_python_env": lambda env: env},
        "utils.task_manager": {"task_manager": Mock()},
    }
    modules = {}
    for name, attributes in dependencies.items():
        module = types.ModuleType(name)
        module.__dict__.update(attributes)
        modules[name] = module
    spec = importlib.util.spec_from_file_location("execute_under_test", SOURCE)
    module = importlib.util.module_from_spec(spec)
    with patch.dict(sys.modules, modules):
        spec.loader.exec_module(module)
    return module


class HeadlessProgressTests(unittest.TestCase):
    def setUp(self):
        self.execute = load_execute()
        self.env = os.environ.copy()
        self.env["PYTHONDONTWRITEBYTECODE"] = "1"

    def run_child(self, script, interpreter=sys.executable):
        command = [str(interpreter), "-B", "-c", script]
        output = io.StringIO()
        with patch.object(self.execute, "_windows_visible_console_size", return_value=None), \
                patch.object(self.execute, "_monitor_windows_console_translate_progress") as monitor, \
                patch.object(self.execute, "_guard_windows_console_min_width"), \
                contextlib.redirect_stdout(output):
            self.execute._execute_with_inherit(command, self.env, "task", 80)
        monitor.assert_not_called()
        return output.getvalue()

    def updates(self):
        return [call.args[1] for call in self.execute.task_manager.update_task.call_args_list]

    def test_real_child_stdout_stderr_cr_ansi_and_unterminated_tail(self):
        output = self.run_child(
            "import os; "
            "os.write(1, b'\\x1b[32mtranslate 1/8\\x1b[0m\\r'); "
            "os.write(2, b'translate 3/8\\r\\n'); "
            "os.write(1, b'translate 5/8')"
        )
        self.assertEqual([u["progress"] for u in self.updates()], [12, 37, 62])
        self.assertIn("translate 3/8", output)

    def test_fragmented_bytes_ansi_utf8_and_multiple_frames(self):
        chunks = [
            b'\r\x1b[3',
            b'2mtrans', b'late 1/', b'10\x1b[0', b'm\rtranslate 4/10\r\n',
            b'\xe4\xb8', b'\xad\xe6\x96\x87\ntranslate 7/', b'10', b'',
        ]
        process = Mock()
        process.stdout.read.side_effect = chunks
        process.wait.return_value = 0
        process.poll.return_value = 0
        with patch.object(self.execute.subprocess, "Popen", return_value=process) as popen, \
                patch.object(self.execute, "_parse_progress", wraps=self.execute._parse_progress) as parse:
            output = self.run_child("pass")
        self.assertEqual([u["progress"] for u in self.updates()], [10, 40, 70])
        self.assertIn("中文", output)
        self.assertTrue(all("translate" in call.args[0] or "中文" in call.args[0]
                            for call in parse.call_args_list))
        self.assertEqual(popen.call_args.kwargs["stdout"], subprocess.PIPE)
        self.assertEqual(popen.call_args.kwargs["stderr"], subprocess.STDOUT)

    def test_nonzero_exit_drains_progress_and_preserves_returncode(self):
        with self.assertRaises(subprocess.CalledProcessError) as caught:
            self.run_child("import os; os.write(2, b'translate 2/8'); raise SystemExit(7)")
        self.assertEqual(caught.exception.returncode, 7)
        self.assertEqual([u["progress"] for u in self.updates()], [25])

    def test_output_without_progress_does_not_invent_updates(self):
        output = self.run_child("print('engine started; still waiting')")
        self.assertIn("engine started", output)
        self.assertEqual(self.updates(), [])

    def test_progress_arrives_while_child_is_still_running(self):
        processes = []
        running_on_update = []
        real_popen = subprocess.Popen

        def launch(*args, **kwargs):
            process = real_popen(*args, **kwargs)
            processes.append(process)
            return process

        def record(task_id, update):
            running_on_update.append(processes[0].poll() is None)

        self.execute.task_manager.update_task.side_effect = record
        with patch.object(self.execute.subprocess, "Popen", side_effect=launch):
            self.run_child(
                "import os, time; os.write(1, b'translate 3/10\\r'); "
                "time.sleep(0.5); os.write(2, b'translate 7/10\\r')"
            )
        self.assertEqual([u["progress"] for u in self.updates()], [30, 70])
        self.assertTrue(running_on_update[0])

    def test_actual_headless_host_routes_to_pipe(self):
        if sys.platform != "win32" or self.execute._windows_visible_console_size() is not None:
            self.skipTest("requires a Windows host with redirected/no console stdout")
        with contextlib.redirect_stdout(io.StringIO()), \
                patch.object(self.execute, "_monitor_windows_console_translate_progress") as monitor:
            self.execute._execute_with_inherit(
                [sys.executable, "-B", "-c", "print('translate 4/10')"],
                self.env, "task", 80,
            )
        monitor.assert_not_called()
        self.assertEqual([u["progress"] for u in self.updates()], [40])

    @unittest.skipUnless(importlib.util.find_spec("rich"), "Rich not installed in test interpreter")
    def test_installed_rich_emits_intermediate_progress_over_pipe(self):
        self.env.update(TTY_COMPATIBLE="0", TTY_INTERACTIVE="0", FORCE_COLOR="", TERM="dumb")
        original = self.env.copy()
        self.run_child(
            "from rich.progress import Progress, TextColumn, MofNCompleteColumn; "
            "p = Progress(TextColumn('{task.description}'), MofNCompleteColumn(), auto_refresh=False); "
            "p.start(); t = p.add_task('translate', total=10); "
            "p.update(t, completed=3, refresh=True); "
            "p.update(t, completed=7, refresh=True); p.stop()",
            ENGINE_PYTHON,
        )
        percentages = [u["progress"] for u in self.updates() if "progress" in u]
        self.assertIn(30, percentages)
        self.assertIn(70, percentages)
        self.assertEqual(self.env, original)

    def test_headless_counter_has_room_in_narrow_host(self):
        self.env['COLUMNS'] = '80'
        self.env['TTY_COLUMNS'] = '80'
        output = self.run_child(
            "import os; assert int(os.environ['COLUMNS']) >= 180; "
            "assert int(os.environ['TTY_COLUMNS']) >= 180; print('translate 38/100')"
        )
        self.assertIn(38, [u['progress'] for u in self.updates()])

    def test_console_available_keeps_inherited_output_and_environment(self):
        process = Mock()
        process.wait.return_value = 0
        with patch.object(self.execute, "_windows_visible_console_size", return_value=(80, 24)), \
                patch.object(self.execute.subprocess, "Popen", return_value=process) as popen, \
                patch.object(self.execute.threading, "Thread"):
            self.execute._execute_with_inherit(["engine"], self.env, "task", 80)
        self.assertIsNone(popen.call_args.kwargs["stdout"])
        self.assertIsNone(popen.call_args.kwargs["stderr"])
        self.assertIs(popen.call_args.kwargs["env"], self.env)


if __name__ == "__main__":
    unittest.main(verbosity=2)
