"""Synthetic credentials only: no real config, process, network or log access."""
from contextlib import redirect_stdout, redirect_stderr
import copy
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / 'server'))

API_KEY = 'synthetic-provider-private-Q7Z9'
HEADER_KEY = 'synthetic-header-private-W8Y6'


class PrivacyTests(unittest.TestCase):
    def credentials(self):
        return {'apiKey': API_KEY, 'apiUrl': 'https://synthetic.invalid/v1',
                'model': 'test-model', 'extraData': {
                    'headers': {'Authorization': 'Bearer ' + HEADER_KEY},
                    'opaque_option': 'synthetic-unknown-extra-value'}}

    def test_config_diagnostics_hide_keys_headers_and_unknown_extra_values(self):
        from utils.config import Config
        credentials = self.credentials()
        before = copy.deepcopy(credentials)
        output = io.StringIO()
        with tempfile.TemporaryDirectory(prefix='privacy-synthetic-') as directory:
            path = Path(directory) / 'synthetic.toml'
            path.write_text('[openai_detail]\n', encoding='utf-8')
            with redirect_stdout(output):
                config = Config({'engine': 'pdf2zh_next', 'next_service': 'openai', 'llm_api': credentials})
                config.update_config_file(path)
            import toml
            actual = toml.loads(path.read_text(encoding='utf-8'))['openai_detail']
            self.assertIn(API_KEY, json.dumps(actual))
            self.assertEqual(actual['headers']['Authorization'], 'Bearer ' + HEADER_KEY)
        self.assertEqual(credentials, before)
        for value in (API_KEY, API_KEY[-4:], HEADER_KEY, 'synthetic-unknown-extra-value'):
            self.assertNotIn(value, output.getvalue())

    def test_known_secrets_and_sensitive_fields_are_redacted_without_mutation(self):
        from utils.privacy import register_credentials, redact_json, redact_text
        credentials = self.credentials()
        register_credentials(credentials)
        original = {'status': 'failed', 'message': 'provider rejected ' + API_KEY,
                    'nested': [{'Authorization': 'Bearer unregistered-header-token'}],
                    'detail': {'password': 'unregistered-password'}}
        before = copy.deepcopy(original)
        clean = redact_json(original)
        self.assertEqual(original, before)
        self.assertIsNot(clean, original)
        text = json.dumps(clean)
        for value in (API_KEY, 'unregistered-header-token', 'unregistered-password'):
            self.assertNotIn(value, text)
        self.assertIn('provider rejected', clean['message'])
        for message in ('Authorization: Bearer unregistered-bearer-value',
                        'api_key=unregistered-key-value',
                        'https://synthetic-user:unregistered-password@synthetic.invalid/v1?token=unregistered-query-token',
                        json.dumps({'apiKey': API_KEY}),
                        'provider echoed ' + HEADER_KEY):
            clean_text = redact_text(message)
            for value in (API_KEY, HEADER_KEY, 'unregistered-bearer-value', 'unregistered-key-value',
                          'unregistered-password', 'unregistered-query-token'):
                self.assertNotIn(value, clean_text)

    def test_diagnostic_copies_hide_extra_data_values_and_secret_object_keys(self):
        from utils.privacy import register_credentials, redact_json
        register_credentials(self.credentials())
        data = {API_KEY: 'provider error', 'extraData': {'opaque_setting': 'synthetic-opaque-extra-D2F4'}}
        original = copy.deepcopy(data)
        clean = json.dumps(redact_json(data))
        self.assertNotIn(API_KEY, clean)
        self.assertNotIn('synthetic-opaque-extra-D2F4', clean)
        self.assertEqual(data, original)

    def test_json_string_extra_headers_are_registered_for_unlabelled_errors(self):
        from utils.privacy import register_credentials, redact_text
        secret = 'synthetic-string-header-only-M3P5'
        register_credentials({'extraData': {'vendor_options': json.dumps({'headers': {'X-Custom': secret}})}})
        self.assertNotIn(secret, redact_text('remote failure: ' + secret))

    def test_stream_handles_split_writes_progress_and_delegates_file_interface(self):
        from utils.privacy import RedactingStream, register_credentials
        register_credentials(self.credentials())
        raw = io.StringIO()
        raw.fileno = lambda: 77
        raw.isatty = lambda: True
        stream = RedactingStream(raw)
        self.assertEqual(stream.fileno(), 77)
        self.assertTrue(stream.isatty())
        self.assertTrue(stream.writable())
        self.assertEqual(stream.write('provider ' + API_KEY[:12]), len('provider ' + API_KEY[:12]))
        stream.write(API_KEY[12:] + '\nprogress 20%\r')
        stream.flush()
        self.assertNotIn(API_KEY, raw.getvalue())
        self.assertIn('progress 20%\r', raw.getvalue())
        self.assertIn('provider', raw.getvalue())

    def test_headless_pipe_flushes_cannot_split_a_registered_secret_into_logs(self):
        from utils.privacy import RedactingStream, register_credentials
        register_credentials(self.credentials())
        raw = io.StringIO()
        stream = RedactingStream(raw)
        stream.write('provider ' + API_KEY[:12])
        stream.flush()
        stream.write(API_KEY[12:] + '\n')
        stream.flush()
        self.assertNotIn(API_KEY, raw.getvalue())
        self.assertNotIn(API_KEY[-4:], raw.getvalue())
        self.assertIn('provider', raw.getvalue())

    def test_error_and_history_responses_are_sanitized_but_pdf_and_state_are_unchanged(self):
        from flask import Flask, Response
        from runtime.security import register_auth
        from utils.privacy import register_credentials
        register_credentials(self.credentials())
        app = Flask(__name__)
        state = {'history': [{'error': 'provider says ' + API_KEY, 'headers': {'X-Custom': HEADER_KEY}}]}
        before = copy.deepcopy(state)
        pdf = b'%PDF-1.7\n' + API_KEY.encode()
        app.add_url_rule('/api/history', endpoint='history', view_func=lambda: state)
        app.add_url_rule('/translate', endpoint='translate', view_func=lambda: ({'status': 'error', 'message': API_KEY}, 400), methods=['POST'])
        app.add_url_rule('/translatedFile/synthetic.pdf', endpoint='pdf', view_func=lambda: Response(pdf, mimetype='application/pdf'))
        register_auth(app, 'a' * 64)
        client = app.test_client()
        args = {'base_url': 'http://127.0.0.1:8891', 'headers': {'X-PDF2zh-Easy-Token': 'a' * 64}}
        history = client.get('/api/history', **args)
        error = client.post('/translate', **args)
        for response in (history, error):
            self.assertTrue(response.is_json)
            self.assertNotIn(API_KEY, response.get_data(as_text=True))
            self.assertNotIn(HEADER_KEY, response.get_data(as_text=True))
        self.assertEqual(error.status_code, 400)
        self.assertEqual(state, before)
        self.assertEqual(client.get('/translatedFile/synthetic.pdf', **args).data, pdf)

    def test_bootstrap_installs_stream_filter_before_loading_server(self):
        from runtime.bootstrap import ManagedRuntime
        from utils.privacy import RedactingStream, register_credentials
        register_credentials(self.credentials())
        with tempfile.TemporaryDirectory(prefix='privacy-bootstrap-') as directory:
            runtime = ManagedRuntime(directory)
            module, spec = Mock(), Mock()
            spec.loader.exec_module.side_effect = lambda _: print('import diagnostic ' + API_KEY)
            raw_out, raw_err = io.StringIO(), io.StringIO()
            with redirect_stdout(raw_out), redirect_stderr(raw_err), patch.object(runtime, 'installed', return_value=True), patch.object(runtime, '_token', return_value='a' * 64), patch.object(runtime, 'environment', return_value={}), patch('runtime.bootstrap.os.chdir'), patch('runtime.bootstrap.importlib.util.spec_from_file_location', return_value=spec), patch('runtime.bootstrap.importlib.util.module_from_spec', return_value=module), patch('runtime.bootstrap.register_auth'):
                def running(*args, **kwargs):
                    self.assertIsInstance(sys.stdout, RedactingStream)
                    self.assertIsInstance(sys.stderr, RedactingStream)
                    print('engine diagnostic ' + API_KEY)
                module.PDFTranslator.return_value.run.side_effect = running
                runtime.serve()
                self.assertIs(sys.stdout, raw_out)
            self.assertNotIn(API_KEY, raw_out.getvalue())
            self.assertIn('import diagnostic', raw_out.getvalue())

    def test_venv_executes_original_argv_but_only_logs_and_raises_sanitized_copies(self):
        from utils.venv import VirtualEnvManager
        manager = object.__new__(VirtualEnvManager)
        command = ['synthetic-python', '--api-key', API_KEY, '--headers', json.dumps({'Authorization': 'Bearer ' + HEADER_KEY})]
        original = list(command)
        process = Mock(stdout=io.StringIO('provider stdout ' + API_KEY + '\n'),
                       stderr=io.StringIO('provider stderr ' + HEADER_KEY + '\n'))
        process.wait.return_value = 1
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err), patch.object(manager, 'get_command_and_env', return_value=(command, {})), patch('utils.venv.quiet_popen', return_value=process) as spawn:
            with self.assertRaises(subprocess.CalledProcessError) as failure:
                manager.execute_in_env(command)
        self.assertEqual(command, original)
        self.assertIs(spawn.call_args.args[0], command)
        self.assertEqual(spawn.call_args.kwargs['stdout'], subprocess.PIPE)
        self.assertIn('provider stdout', out.getvalue())
        for value in (API_KEY, HEADER_KEY):
            self.assertNotIn(value, out.getvalue() + err.getvalue())
            self.assertNotIn(value, str(failure.exception) + failure.exception.stderr)


class ProbeIdleGateTests(unittest.TestCase):
    def setUp(self):
        from runtime import bootstrap
        self.module = bootstrap
        self.directory = tempfile.TemporaryDirectory(prefix='probe-synthetic-')
        self.addCleanup(self.directory.cleanup)
        self.runtime = bootstrap.ManagedRuntime(self.directory.name)
        self.enterContext(patch.object(self.runtime, '_probe', return_value=False))

    def run_probe(self):
        with patch.object(self.module.sys, 'argv', ['bootstrap.py', 'probe']), patch.object(self.module, 'ManagedRuntime', return_value=self.runtime):
            return self.module.main()

    def test_absent_lock_and_refused_health_confirm_idle_without_creating_files(self):
        before = set(self.runtime.root.iterdir())
        self.assertEqual(self.run_probe(), 3)
        self.assertEqual(set(self.runtime.root.iterdir()), before)

    def test_existing_held_lifetime_lock_reports_busy_using_readonly_handle(self):
        lock = self.runtime.root / 'service.lock'
        lock.write_bytes(b'original synthetic lock contents')
        original = lock.read_bytes()
        with self.module.file_lock(lock, 0):
            self.assertEqual(self.run_probe(), 0)
        self.assertEqual(lock.read_bytes(), original)
        self.assertFalse((self.runtime.root / 'status.json').exists())
        self.assertFalse((self.runtime.root / 'service-token').exists())

    def test_existing_unlocked_lifetime_lock_is_opened_rb_and_never_rewritten(self):
        lock = self.runtime.root / 'service.lock'
        lock.write_bytes(b'original synthetic lock contents')
        original_open = Path.open
        calls = []
        def opened(path, *args, **kwargs):
            if path == lock:
                calls.append(args[0] if args else kwargs.get('mode'))
            return original_open(path, *args, **kwargs)
        with patch.object(Path, 'open', opened):
            self.assertEqual(self.run_probe(), 3)
        self.assertEqual(calls, ['rb'])
        self.assertEqual(lock.read_bytes(), b'original synthetic lock contents')

    def test_verified_pending_identity_is_busy_even_before_lifetime_lock(self):
        with patch.object(self.runtime, '_pid_alive', return_value=True):
            self.assertEqual(self.run_probe(), 0)

    def test_unreadable_pending_identity_refuses_idle_confirmation(self):
        with patch.object(self.runtime, '_pid_alive', side_effect=RuntimeError('identity unavailable')):
            self.assertEqual(self.run_probe(), 1)


if __name__ == '__main__':
    unittest.main()
