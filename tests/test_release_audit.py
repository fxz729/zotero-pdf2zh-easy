"""Release audit regressions use synthetic bytes/credentials and temporary repos only."""
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
import warnings
from unittest.mock import patch
from zipfile import ZipFile, ZipInfo

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'audit_release.py'
if SCRIPT.exists():
    spec = importlib.util.spec_from_file_location('release_audit_under_test', SCRIPT)
    audit = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(audit)
else:
    audit = SimpleNamespace()

VERSION = '0.1.1'
RUNTIME_VERSION = '0.1.0'
FEED = 'https://github.com/fxz729/zotero-pdf2zh-easy/releases/latest/download/update.json'
RUNTIME_PATHS = [
    'runtime/bootstrap.py', 'runtime/security.py', 'runtime/requirements-server.txt', 'runtime/requirements-engine.txt',
    'runtime/LICENSE', 'server/server.py', 'server/index.html', 'server/favicon.svg',
    'server/config/config.json.example', 'server/config/config.toml.example', 'server/config/venv.json.example',
] + ['server/utils/' + name + '.py' for name in [
    'auto_update', 'config', 'config_map', 'config_migration', 'cropper', 'deepseek_thinking',
    'environment_lifecycle', 'execute', 'package_network', 'privacy', 'record', 'silent_process', 'task_manager', 'venv',
]]


def archive_entries():
    manifest = {'manifest_version': 2, 'name': 'PDF2zh Easy', 'version': VERSION,
                'applications': {'zotero': {'id': 'pdf2zh-easy@fxz729', 'update_url': FEED}}}
    entries = {'manifest.json': json.dumps(manifest).encode(), 'content/scripts/pdf2zhEasy.js': b'/* public application */'}
    files = []
    for name in RUNTIME_PATHS:
        data = ('synthetic public source for ' + name + '\n').encode()
        entries['content/runtime/' + name] = data
        files.append({'path': name, 'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
    entries['content/runtime/runtime-manifest.json'] = json.dumps({'version': RUNTIME_VERSION, 'files': files}).encode()
    return entries


class ReleaseAuditTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='release-audit-synthetic-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def zip(self, entries=None):
        path = self.root / 'synthetic.xpi'
        with ZipFile(path, 'w') as archive:
            for name, data in (entries or archive_entries()).items():
                if '\\' in name:
                    info = ZipInfo('synthetic'); info.filename = name; info.orig_filename = name
                    archive.writestr(info, data)
                else:
                    archive.writestr(name, data)
        return path

    def problems(self, result):
        return {item['category'] for item in result['problems']}

    def test_valid_archive_checks_all_25_runtime_assets_and_hashes_the_xpi(self):
        self.assertTrue(callable(getattr(audit, 'audit_archive', None)), 'archive auditor is required')
        path = self.zip()
        before = path.read_bytes()
        result = audit.audit_archive(path)
        self.assertTrue(result['ok'], result['problems'])
        self.assertEqual(result['sha256']['xpi'], hashlib.sha256(before).hexdigest())
        self.assertEqual(result['runtime_files_verified'], 25)
        self.assertEqual(path.read_bytes(), before)

    def test_missing_extensionless_runtime_license_is_rejected(self):
        entries = archive_entries()
        del entries['content/runtime/runtime/LICENSE']
        result = audit.audit_archive(self.zip(entries))
        self.assertFalse(result['ok'])
        self.assertIn('runtime_asset_missing', self.problems(result))

    def test_changed_runtime_bytes_and_declared_size_are_rejected(self):
        for mode in ['hash', 'size']:
            with self.subTest(mode=mode):
                entries = archive_entries()
                name = 'content/runtime/runtime/security.py'
                if mode == 'hash':
                    entries[name] = b'X' * len(entries[name])
                else:
                    entries[name] += b'extra'
                result = audit.audit_archive(self.zip(entries))
                self.assertFalse(result['ok'])
                self.assertIn('runtime_asset_' + mode + '_mismatch', self.problems(result))

    def test_manifest_cannot_omit_required_license_or_hide_an_unlisted_runtime_file(self):
        entries = archive_entries()
        name = 'content/runtime/runtime-manifest.json'
        data = json.loads(entries[name])
        data['files'] = [entry for entry in data['files'] if entry['path'] != 'runtime/LICENSE']
        entries[name] = json.dumps(data).encode()
        result = audit.audit_archive(self.zip(entries))
        self.assertFalse(result['ok'])
        self.assertIn('runtime_manifest_inventory', self.problems(result))

    def test_runtime_manifest_rejects_duplicate_traversal_or_invalid_hash_entries(self):
        for change in ['duplicate', 'traversal', 'hash']:
            entries = archive_entries()
            name = 'content/runtime/runtime-manifest.json'
            data = json.loads(entries[name])
            if change == 'duplicate': data['files'].append(data['files'][0])
            elif change == 'traversal': data['files'][0]['path'] = '../escape'
            else: data['files'][0]['sha256'] = 'invalid'
            entries[name] = json.dumps(data).encode()
            self.assertFalse(audit.audit_archive(self.zip(entries))['ok'])

    def test_independent_identity_version_and_latest_update_feed_are_required(self):
        for field, value in [('id', 'old-addon@example.invalid'), ('version', '9.9.9'), ('update_url', 'https://example.invalid/release/update.json')]:
            entries = archive_entries()
            manifest = json.loads(entries['manifest.json'])
            if field == 'version': manifest[field] = value
            else: manifest['applications']['zotero'][field] = value
            entries['manifest.json'] = json.dumps(manifest).encode()
            self.assertFalse(audit.audit_archive(self.zip(entries))['ok'])

    def test_native_scratch_markers_and_driver_entries_are_never_release_assets(self):
        for name, data in [
            ('content/scripts/pdf2zhEasy.js', b'/* __PDF2ZH_EASY_NATIVE_TEST_ONLY__ */'),
            ('content/scripts/pdf2zhEasy.js', b'/* NATIVE_ONLY */'),
            ('content/scripts/native-smoke-driver.js', b'/* scratch code */'),
        ]:
            entries = archive_entries(); entries[name] = data
            result = audit.audit_archive(self.zip(entries))
            self.assertFalse(result['ok'])
            self.assertTrue(any('native' in category for category in self.problems(result)))

    def test_tokens_and_key_assignments_are_rejected_without_disclosing_values(self):
        values = ['sk-' + 'SyntheticCredential' * 3, 'ghp_' + 'SyntheticCredential' * 3,
                  'github_pat_' + 'SyntheticCredential' * 3, 'AKIA' + 'A1' * 8]
        for secret in values:
            entries = archive_entries(); entries['content/payload.txt'] = secret.encode()
            result = audit.audit_archive(self.zip(entries))
            self.assertFalse(result['ok'])
            self.assertTrue(secret not in json.dumps(result), 'diagnostics must not disclose matched values')
        opaque = 'synthetic-opaque-provider-value'
        entries = archive_entries(); entries['content/payload.json'] = json.dumps({'apiKey': opaque}).encode()
        result = audit.audit_archive(self.zip(entries))
        self.assertFalse(result['ok'])
        self.assertTrue(opaque not in json.dumps(result), 'diagnostics must not disclose assigned values')

    def test_windows_user_paths_are_synthetic_and_never_echoed_in_reports(self):
        private = r'C:\Users\SyntheticPerson\AppData\synthetic-only'
        entries = archive_entries(); entries['content/payload.txt'] = private.encode()
        result = audit.audit_archive(self.zip(entries))
        self.assertIn('windows_user_path', self.problems(result))
        self.assertTrue('SyntheticPerson' not in json.dumps(result), 'diagnostics must not disclose account names')

    def test_path_names_containing_credentials_are_redacted_too(self):
        secret = 'sk-' + 'SyntheticCredential' * 3
        entries = archive_entries(); entries['content/' + secret + '.txt'] = b'synthetic'
        result = audit.audit_archive(self.zip(entries))
        self.assertFalse(result['ok'])
        self.assertTrue(secret not in json.dumps(result), 'even paths must be safe to print')
        opaque = 'synthetic-opaque-path-value'
        entries = archive_entries(); entries["content/apiKey='" + opaque + "'.txt"] = b'synthetic'
        result = audit.audit_archive(self.zip(entries))
        self.assertFalse(result['ok'])
        self.assertTrue(opaque not in json.dumps(result), 'assigned values in paths must be redacted too')

    def test_private_paths_are_denied_but_empty_example_templates_are_allowed(self):
        for name in ['server/config/config.json', 'service-token', 'install.log', 'paper.pdf', 'state.sqlite', '.venv/bin/python', 'profile/prefs.js']:
            entries = archive_entries(); entries['content/' + name] = b'not read'
            result = audit.audit_archive(self.zip(entries))
            self.assertIn('forbidden_entry', self.problems(result))
        entries = archive_entries(); entries['content/config.json.example'] = b'{"apiKey":""}'
        self.assertTrue(audit.audit_archive(self.zip(entries))['ok'])
        entries['content/config.json.example'] = b'{"apiKey":"synthetic-opaque-value"}'
        self.assertFalse(audit.audit_archive(self.zip(entries))['ok'])

    def test_archive_does_not_exempt_synthetic_secrets_inside_test_files(self):
        entries = archive_entries(); entries['tests/fixture.txt'] = ('sk-' + 'SyntheticCredential' * 3).encode()
        self.assertFalse(audit.audit_archive(self.zip(entries))['ok'])

    def test_unsafe_duplicate_and_symlink_zip_entries_are_rejected(self):
        for name in ['../escape', '/absolute', 'C:/outside', 'content\\escape']:
            entries = archive_entries(); entries[name] = b'unsafe'
            self.assertFalse(audit.audit_archive(self.zip(entries))['ok'])
        path = self.zip()
        with ZipFile(path, 'a') as archive:
            info = ZipInfo('content/link'); info.create_system = 3; info.external_attr = (stat.S_IFLNK | 0o777) << 16
            archive.writestr(info, 'outside')
        self.assertIn('symlink_entry', self.problems(audit.audit_archive(path)))

    def test_mapping_shaped_values_outside_the_known_schema_are_not_globally_exempt(self):
        entries = archive_entries()
        entries['content/mapping.py'] = b'fields = {"api_key": "openai_compatible_api_key"}'
        self.assertFalse(audit.audit_archive(self.zip(entries))['ok'])

    def test_short_nonplaceholder_keys_and_password_self_aliases_are_rejected(self):
        for data in [b'password = "password"', b'apiKey = "short-value"']:
            entries = archive_entries(); entries['content/payload.txt'] = data
            self.assertFalse(audit.audit_archive(self.zip(entries))['ok'])

    def test_config_map_schema_aliases_do_not_exempt_unrelated_password_literals(self):
        directory = self.root / 'server/utils'; directory.mkdir(parents=True)
        target = directory / 'config_map.py'
        public = 'apiKey = "apiKey"\nfields = {apiKey: "UNUSUAL_PROVIDER_CREDENTIAL_FIELD"}\n'
        target.write_text(public, encoding='utf-8')
        self.assertTrue(audit.audit_sources(self.root, ['server/utils/config_map.py'])['ok'])
        target.write_text(public + 'password = "arbitrary-sensitive-password"\n', encoding='utf-8')
        self.assertFalse(audit.audit_sources(self.root, ['server/utils/config_map.py'])['ok'])

    def test_fixture_placeholders_and_header_injection_payloads_are_not_real_credentials(self):
        (self.root / 'tests').mkdir()
        data = json.dumps({'apiKey': 'secret-actual', 'Authorization': 'Bearer unregistered-header-token', 'password': 'unregistered-password'})
        data += '\\n' + 'apiKey: "key\\\\r\\\\nInjected: true"'
        (self.root / 'tests/fixture.py').write_text(data, encoding='utf-8')
        self.assertTrue(audit.audit_sources(self.root, ['tests/fixture.py'])['ok'])
        (self.root / 'main.py').write_text(data, encoding='utf-8')
        self.assertFalse(audit.audit_sources(self.root, ['main.py'])['ok'])

    def test_reviewed_public_literal_exemption_requires_hash_and_exact_line_and_keeps_token_scan(self):
        name = 'content/llmApiEditor.xhtml'
        data = b'apiKey: "API Key display label"\n'
        policy = {name: (hashlib.sha256(data).hexdigest(), frozenset({1}))}
        entries = archive_entries(); entries[name] = data
        with patch.object(audit, 'PUBLIC_LITERAL_LINES', policy, create=True):
            self.assertTrue(audit.audit_archive(self.zip(entries))['ok'])
            entries[name] = data + b'password = "password"\n'
            self.assertFalse(audit.audit_archive(self.zip(entries))['ok'])
        token_data = ('apiKey: "sk-' + 'SyntheticCredential' * 3 + '"\n').encode()
        policy = {name: (hashlib.sha256(token_data).hexdigest(), frozenset({1}))}
        entries[name] = token_data
        with patch.object(audit, 'PUBLIC_LITERAL_LINES', policy, create=True):
            self.assertFalse(audit.audit_archive(self.zip(entries))['ok'])

    def test_duplicate_zip_headers_are_rejected_without_extracting(self):
        path = self.zip()
        with warnings.catch_warnings():
            warnings.simplefilter('ignore', UserWarning)
            with ZipFile(path, 'a') as archive:
                archive.writestr('manifest.json', b'{}')
        self.assertIn('duplicate_entry', self.problems(audit.audit_archive(path)))

    def test_source_fixtures_allow_synthetic_secrets_but_production_sources_do_not(self):
        secret = 'sk-' + 'SyntheticCredential' * 3
        (self.root / 'tests').mkdir()
        (self.root / 'tests/fixture.py').write_text(secret, encoding='utf-8')
        (self.root / 'main.py').write_text(secret, encoding='utf-8')
        result = audit.audit_sources(self.root, ['tests/fixture.py'])
        self.assertTrue(result['ok'])
        result = audit.audit_sources(self.root, ['main.py'])
        self.assertFalse(result['ok'])
        self.assertTrue(secret not in json.dumps(result), 'source diagnostics must not disclose credentials')

    def test_test_directory_does_not_hide_unmarked_token_shaped_credentials(self):
        (self.root / 'tests').mkdir()
        value = 'ghp_' + 'A1' * 20
        (self.root / 'tests/fixture.py').write_text(value, encoding='utf-8')
        result = audit.audit_sources(self.root, ['tests/fixture.py'])
        self.assertFalse(result['ok'])
        self.assertTrue(value not in json.dumps(result), 'fixture errors must never disclose token-shaped values')

    def test_forbidden_source_paths_are_reported_without_reading_them(self):
        with patch.object(Path, 'read_bytes', side_effect=AssertionError('private contents must never be read')):
            result = audit.audit_sources(self.root, ['server/config/config.json', 'research/profile/prefs.js', 'private.log'])
        self.assertFalse(result['ok'])
        self.assertEqual(self.problems(result), {'forbidden_entry'})

    @unittest.skipUnless(shutil.which('git'), 'git source inventory requires git')
    def test_git_inventory_includes_tracked_and_untracked_but_not_ignored_content(self):
        subprocess.run(['git', 'init', '--quiet', str(self.root)], check=True, capture_output=True)
        (self.root / '.gitignore').write_text('research/\n*.log\n', encoding='utf-8')
        (self.root / 'tracked.py').write_text('public = 1\n', encoding='utf-8')
        subprocess.run(['git', '-C', str(self.root), 'add', 'tracked.py', '.gitignore'], check=True, capture_output=True)
        (self.root / 'untracked.py').write_text('public = 2\n', encoding='utf-8')
        (self.root / 'research').mkdir(); (self.root / 'research/fixture.txt').write_text('ignored synthetic data', encoding='utf-8')
        (self.root / 'synthetic.log').write_text('ignored synthetic data', encoding='utf-8')
        paths = audit.git_source_paths(self.root)
        self.assertEqual(set(paths), {'.gitignore', 'tracked.py', 'untracked.py'})

    def test_archive_only_cli_works_without_git_and_uses_the_callers_xpi_path(self):
        path = self.zip()
        run = subprocess.run([sys.executable, '-B', str(SCRIPT), '--archive-only', '--xpi', path.name], cwd=self.root, capture_output=True, text=True)
        self.assertEqual(run.returncode, 0, 'archive-only must work in a non-repository directory')
        result = json.loads(run.stdout)
        self.assertTrue(result['ok'])
        self.assertEqual(result['runtime_files_verified'], 25)
        self.assertEqual(run.stderr, '')


if __name__ == '__main__':
    unittest.main()
