"""No console-subsystem child may bypass the background spawn boundary."""
import ast
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]


class ProcessBoundaryTests(unittest.TestCase):
    def test_runtime_children_use_managed_quiet_spawn(self):
        violations = []
        for relative in ['server.py', 'utils/execute.py', 'utils/venv.py', 'utils/environment_lifecycle.py', 'utils/deepseek_thinking.py']:
            tree = ast.parse((ROOT / 'server' / relative).read_text(encoding='utf-8-sig'))
            for node in ast.walk(tree):
                if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and isinstance(node.func.value, ast.Name):
                    if node.func.value.id == 'subprocess' and node.func.attr in {'Popen', 'run', 'call', 'check_call', 'check_output'}:
                        violations.append(f'{relative}:{node.lineno}')
        self.assertEqual(violations, [], 'Unmanaged spawn boundaries can flash console windows')


if __name__ == '__main__':
    unittest.main()
