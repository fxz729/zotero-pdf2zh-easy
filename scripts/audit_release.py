"""Offline, read-only source/XPI gate. Reports categories, never matched values.

Default source scope is git's tracked plus non-ignored untracked inventory; it
never walks a profile/research directory. --archive-only needs no Git checkout.
This is a conservative pattern/inventory check, not proof that data is public.
"""
import argparse
import ast
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import sys
from zipfile import BadZipFile, ZipFile

VERSION = '0.1.1'
RUNTIME_VERSION = '0.1.0'
ADDON_ID = 'pdf2zh-easy@fxz729'
UPDATE_URL = 'https://github.com/fxz729/zotero-pdf2zh-easy/releases/latest/download/update.json'
RUNTIME_PREFIX = 'content/runtime/'
RUNTIME_MANIFEST = RUNTIME_PREFIX + 'runtime-manifest.json'
# Explicit source-only contract, matching this release's package-runtime script.
REQUIRED_RUNTIME = frozenset([
    'runtime/bootstrap.py', 'runtime/security.py', 'runtime/requirements-server.txt', 'runtime/requirements-engine.txt',
    'runtime/LICENSE', 'server/server.py', 'server/index.html', 'server/favicon.svg',
    'server/config/config.json.example', 'server/config/config.toml.example', 'server/config/venv.json.example',
] + ['server/utils/' + name + '.py' for name in [
    'auto_update', 'config', 'config_map', 'config_migration', 'cropper', 'deepseek_thinking',
    'environment_lifecycle', 'execute', 'package_network', 'privacy', 'record', 'silent_process', 'task_manager', 'venv',
]])
# Reviewed upstream UI labels/schema literals only. Byte changes invalidate the
# exception; token/private-path checks still apply to every byte of this file.
PUBLIC_EDITOR_SHA256 = 'b03450b69c3a5cb573faf8bf0645f252e2ab3ae96d475a8afe699670cf70c7c3'
PUBLIC_LITERAL_LINES = {
    'plugin/addon/content/llmApiEditor.xhtml': (PUBLIC_EDITOR_SHA256, frozenset({791, 836, 1116})),
    # Independently reviewed: only __addonRef__ -> pdf2zhEasy substitution.
    'content/llmApiEditor.xhtml': ('b09d899e6e764f91cbcddaacfa01fed1051d4899dc2038a008b4ead9cbca9d8d', frozenset({791, 836, 1116})),
}
MAX_FILE = 8 * 1024 * 1024
MAX_TOTAL = 32 * 1024 * 1024
MAX_ARCHIVE = 64 * 1024 * 1024
TOKEN_PATTERNS = {
    'credential_token': re.compile(r'(?<![\w-])(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|(?:AKIA|ASIA)[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{30,}|xox[baprs]-[A-Za-z0-9-]{10,})(?![\w-])'),
    'private_key': re.compile(r'-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----'),
    'windows_user_path': re.compile(r'(?i)[A-Z]:[\\/]+(?:[^\\/\r\n"\'<>:]+[\\/]+)*?(?:Users|Documents and Settings)[\\/]+[^\\/\r\n"\'<>:]+'),
}
KEY_ASSIGNMENT = re.compile(r'''(?ix)\b(?:[a-z0-9]+_)*(?:api_?key|access_?token|authorization|password|secret)\b["']?\s*[:=]\s*["']([^"'\r\n]+)["']''')
PLACEHOLDERS = frozenset(['null', 'none', 'redacted', '[redacted]', '<redacted>', '<key>', '<api_key>',
                          'your_api_key', 'your-api-key', 'your_api_key_here', 'your-api-key-here',
                          'your_key', 'your-key', 'your_openai_api_key', 'changeme'])


def _safe_name(name):
    return (isinstance(name, str) and bool(name) and '\\' not in name and '\0' not in name
            and not name.startswith('/') and not re.match(r'^[A-Za-z]:', name)
            and all(part not in ('', '.', '..') for part in name.split('/')))


def _label(name):
    value = str(name)
    for pattern in TOKEN_PATTERNS.values():
        value = pattern.sub('[redacted]', value)
    value = KEY_ASSIGNMENT.sub(lambda match: match.group().replace(match.group(1), '[redacted]'), value)
    return value[:240]


def _report():
    return {'ok': True, 'problems': [], 'sha256': {}, 'runtime_files_verified': 0}


def _problem(report, name, category):
    problem = {'path': _label(name), 'category': category}
    if problem not in report['problems']:
        report['problems'].append(problem)
    report['ok'] = False


def _forbidden(name, archive=False):
    parts = PurePosixPath(name.lower()).parts
    base = parts[-1] if parts else ''
    blocked = {'.git', 'research', 'profile', 'profiles', 'node_modules', '__pycache__',
               '.venv', 'venv', 'runtime-data', 'logs', 'translated', 'scratch'}
    if any(part in blocked or part.endswith('-venv') for part in parts):
        return True
    if archive and any(part in ('tests', 'test', '.github') for part in parts):
        return True
    if base.endswith(('.pdf', '.log', '.db', '.sqlite', '.sqlite3', '.pyc', '.pyo', '.pem', '.key', '.p12', '.pfx', '.zip', '.xpi', '.7z', '.tar', '.gz')):
        return True
    if base in {'service-token', 'server-pid.json', 'status.json', 'installation.json', 'install.lock', 'launch.lock', 'service.lock', 'user.js'}:
        return True
    if base == '.env' or base.startswith('.env.') and base != '.env.example':
        return True
    return base in {'config.json', 'config.toml', 'venv.json', 'prefs.json'}


def _synthetic(value):
    return any(marker in value.lower() for marker in ('synthetic', 'test-only', 'not-a-real'))


def _schema_alias_spans(text, filename):
    # This upstream module declares apiKey as its own schema alias and uses it
    # as a dictionary key for public environment-field names. No file-wide or
    # password/secret exemption: only these exact AST literal spans qualify.
    if filename not in {'server/utils/config_map.py', RUNTIME_PREFIX + 'server/utils/config_map.py'} or len(text) > 256 * 1024:
        return []
    try:
        tree = ast.parse(text)
    except (SyntaxError, ValueError, RecursionError):
        return []
    def pairs(target, value):
        if isinstance(target, (ast.Tuple, ast.List)) and isinstance(value, (ast.Tuple, ast.List)):
            return [pair for left, right in zip(target.elts, value.elts) for pair in pairs(left, right)]
        return [(target, value)]
    literals = []
    aliased = False
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign):
            for target in node.targets:
                for left, right in pairs(target, node.value):
                    if isinstance(left, ast.Name) and left.id == 'apiKey' and isinstance(right, ast.Constant) and right.value == 'apiKey':
                        aliased = True; literals.append(right)
    if not aliased:
        return []
    for node in ast.walk(tree):
        if isinstance(node, ast.Dict):
            for key, value in zip(node.keys, node.values):
                if isinstance(key, ast.Name) and key.id == 'apiKey' and isinstance(value, ast.Constant) and isinstance(value.value, str) and re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', value.value):
                    literals.append(value)
    lines = text.splitlines(keepends=True)
    def offset(line, column):
        return sum(map(len, lines[:line - 1])) + len(lines[line - 1].encode('utf-8')[:column].decode('utf-8', errors='ignore'))
    return [(offset(node.lineno, node.col_offset), offset(node.end_lineno, node.end_col_offset)) for node in literals]


def _scan(data, fixture=False, native=False, filename=''):
    if data.startswith((b'\xff\xfe', b'\xfe\xff')):
        text = data.decode('utf-16', errors='replace')
    else:
        text = data.decode('utf-8', errors='replace').replace('\0', '')
    categories = set()
    for category, pattern in TOKEN_PATTERNS.items():
        if any(not fixture or not _synthetic(match.group()) for match in pattern.finditer(text)):
            categories.add(category)
    schema_spans = _schema_alias_spans(text, filename)
    policy = PUBLIC_LITERAL_LINES.get(filename)
    public_lines = policy[1] if policy and hashlib.sha256(data).hexdigest() == policy[0] else frozenset()
    for match in KEY_ASSIGNMENT.finditer(text):
        if text.count('\n', 0, match.start(1)) + 1 in public_lines:
            continue
        if any(start <= match.start(1) and match.end(1) <= end for start, end in schema_spans):
            continue
        # Test-scoped literal assignments are fixtures; recognizable token/path
        # patterns above still reject unmarked credentials even in test files.
        if fixture:
            continue
        value = match.group(1).strip()
        if (value.lower() in PLACEHOLDERS or not value.strip('*•')
                or re.fullmatch(r'(?:Bearer\s+)?\$\{[^}]+\}', value)):
            continue
        categories.add('credential_assignment')
    if native and ('__PDF2ZH_EASY_NATIVE_TEST_ONLY__' in text or 'NATIVE_ONLY' in text or '__NATIVE_REPORT__' in text):
        categories.add('native_test_marker')
    return categories


def git_source_paths(root):
    root = Path(root).resolve()
    try:
        top = subprocess.run(['git', '-C', str(root), 'rev-parse', '--show-toplevel'], capture_output=True, check=True, timeout=10).stdout.decode('utf-8').strip()
        if Path(top).resolve() != root:
            raise ValueError()
        output = subprocess.run(['git', '-C', str(root), 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], capture_output=True, check=True, timeout=10).stdout
        return sorted(set(value.decode('utf-8') for value in output.split(b'\0') if value))
    except (OSError, ValueError, subprocess.SubprocessError):
        raise RuntimeError('Source inventory could not be verified.') from None


def audit_sources(root, paths=None):
    report = _report()
    root = Path(root).resolve()
    try:
        paths = git_source_paths(root) if paths is None else paths
    except RuntimeError:
        _problem(report, '<source>', 'git_inventory_unavailable')
        return report
    inventory = hashlib.sha256()
    for name in sorted(set(paths)):
        if not _safe_name(name):
            _problem(report, name, 'unsafe_entry'); continue
        if _forbidden(name):
            _problem(report, name, 'forbidden_entry'); continue
        for category in _scan(name.encode()):
            _problem(report, name, category)
        target = root
        linked = False
        for part in name.split('/'):
            target = target / part
            if target.is_symlink(): linked = True; break
        if linked:
            _problem(report, name, 'symlink_entry'); continue
        try:
            if not target.is_file() or target.stat().st_size > MAX_FILE:
                _problem(report, name, 'source_unreadable_or_oversized'); continue
            data = target.read_bytes()
        except OSError:
            _problem(report, name, 'source_unreadable_or_oversized'); continue
        fixture = name.startswith(('tests/', 'plugin/tests/'))
        for category in _scan(data, fixture=fixture, filename=name):
            _problem(report, name, category)
        inventory.update(name.encode() + b'\0' + hashlib.sha256(data).digest())
    report['sha256']['source_inventory'] = inventory.hexdigest()
    return report


def _validate_addon(report, files):
    try:
        manifest = json.loads(files['manifest.json'])
        zotero = manifest['applications']['zotero']
        if zotero.get('id') != ADDON_ID: _problem(report, 'manifest.json', 'manifest_identity')
        if manifest.get('version') != VERSION: _problem(report, 'manifest.json', 'manifest_version')
        if zotero.get('update_url') != UPDATE_URL: _problem(report, 'manifest.json', 'manifest_update_url')
    except (KeyError, ValueError, TypeError, AttributeError):
        _problem(report, 'manifest.json', 'manifest_invalid_or_missing')


def _validate_runtime(report, files):
    try:
        manifest = json.loads(files[RUNTIME_MANIFEST])
        entries = manifest['files']
        if manifest.get('version') != RUNTIME_VERSION or not isinstance(entries, list) or not entries or len(entries) > 100:
            raise ValueError()
    except (KeyError, ValueError, TypeError, AttributeError):
        _problem(report, RUNTIME_MANIFEST, 'runtime_manifest_invalid_or_missing'); return
    declared = set()
    for entry in entries:
        if not isinstance(entry, dict):
            _problem(report, RUNTIME_MANIFEST, 'runtime_manifest_entry'); continue
        name, size, digest = entry.get('path'), entry.get('size'), entry.get('sha256')
        if (not _safe_name(name) or name in declared or type(size) is not int or not 0 <= size <= 1024 * 1024
                or not isinstance(digest, str) or not re.fullmatch(r'[a-f0-9]{64}', digest)):
            _problem(report, RUNTIME_MANIFEST, 'runtime_manifest_entry'); continue
        declared.add(name)
        full = RUNTIME_PREFIX + name
        data = files.get(full)
        if data is None:
            _problem(report, full, 'runtime_asset_missing'); continue
        valid = True
        if len(data) != size:
            _problem(report, full, 'runtime_asset_size_mismatch'); valid = False
        if hashlib.sha256(data).hexdigest() != digest:
            _problem(report, full, 'runtime_asset_hash_mismatch'); valid = False
        if valid: report['runtime_files_verified'] += 1
    actual = {name[len(RUNTIME_PREFIX):] for name in files if name.startswith(RUNTIME_PREFIX) and name != RUNTIME_MANIFEST}
    if declared != REQUIRED_RUNTIME or actual != declared:
        _problem(report, RUNTIME_MANIFEST, 'runtime_manifest_inventory')


def audit_archive(path):
    report = _report()
    path = Path(path)
    try:
        if path.is_symlink():
            _problem(report, '<xpi>', 'symlink_entry'); return report
        if path.stat().st_size > MAX_ARCHIVE:
            _problem(report, '<xpi>', 'archive_oversized'); return report
        digest = hashlib.sha256()
        with path.open('rb') as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b''): digest.update(chunk)
        report['sha256']['xpi'] = digest.hexdigest()
        files, seen, total = {}, set(), 0
        with ZipFile(path) as archive:
            entries = archive.infolist()
            if len(entries) > 1024:
                _problem(report, '<xpi>', 'archive_too_many_entries'); return report
            for entry in entries:
                # ZipInfo.filename can normalize backslashes/truncate NUL on
                # Windows. Validate the original header name, not that rewrite.
                raw_name = entry.orig_filename
                name = raw_name[:-1] if raw_name.endswith('/') else raw_name
                if not _safe_name(name):
                    _problem(report, name, 'unsafe_entry'); continue
                if name.casefold() in seen:
                    _problem(report, name, 'duplicate_entry'); continue
                seen.add(name.casefold())
                if stat.S_ISLNK(entry.external_attr >> 16):
                    _problem(report, name, 'symlink_entry'); continue
                if _forbidden(name, archive=True):
                    _problem(report, name, 'forbidden_entry'); continue
                if re.search(r'(?i)(?:native[-_]smoke|native[-_]only|smoke[-_]driver)', name):
                    _problem(report, name, 'native_test_entry'); continue
                for category in _scan(name.encode(), native=True): _problem(report, name, category)
                if entry.is_dir(): continue
                total += entry.file_size
                if entry.flag_bits & 1 or entry.file_size > MAX_FILE or total > MAX_TOTAL:
                    _problem(report, name, 'encrypted_or_oversized_entry'); continue
                data = archive.read(entry)
                if len(data) != entry.file_size:
                    _problem(report, name, 'archive_entry_size_mismatch'); continue
                for category in _scan(data, native=True, filename=name): _problem(report, name, category)
                if name == 'content/llmApiEditor.xhtml':
                    report['sha256']['public_editor_asset'] = hashlib.sha256(data).hexdigest()
                files[name] = data
        _validate_addon(report, files)
        _validate_runtime(report, files)
    except (OSError, BadZipFile, ValueError, RuntimeError, NotImplementedError):
        _problem(report, '<xpi>', 'archive_unreadable')
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive-only', action='store_true', help='audit only the XPI; no Git or source reads')
    parser.add_argument('--repo', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--xpi', type=Path, help='relative paths are relative to the current working directory')
    args = parser.parse_args(argv)
    xpi = args.xpi if args.xpi is not None else args.repo / 'plugin/build/pdf-2-zh-easy.xpi'
    archive = audit_archive(xpi)
    if not args.archive_only:
        source = audit_sources(args.repo)
        archive['ok'] = archive['ok'] and source['ok']
        archive['problems'] = source['problems'] + archive['problems']
        archive['sha256'].update(source['sha256'])
    print(json.dumps(archive, ensure_ascii=True, sort_keys=True))
    return 0 if archive['ok'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
