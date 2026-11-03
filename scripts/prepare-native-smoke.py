"""Create a disposable, credential-free Zotero profile and test-only XPI.

Never modifies the normal profile or the release XPI. Run a fresh build first.
The driver uses the production installer and captures only its empty test UI.
"""
import argparse
from datetime import datetime
import hashlib
import json
from pathlib import Path
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[1]
MARKER = '__PDF2ZH_EASY_NATIVE_TEST_ONLY__'


def prepare():
    release = ROOT / 'plugin/build/pdf-2-zh-easy.xpi'
    release_hash = hashlib.sha256(release.read_bytes()).hexdigest()
    home = ROOT / 'research' / ('native-smoke-' + datetime.now().strftime('%Y%m%d-%H%M%S'))
    if home.exists():
        raise RuntimeError('Refusing to reuse an existing smoke-test directory.')
    profile = home / 'profile'
    (profile / 'extensions').mkdir(parents=True)
    library = home / 'library'
    library.mkdir()
    report = home / 'native-result.json'
    package = json.loads((ROOT / 'plugin/package.json').read_text(encoding='utf-8'))
    addon_id = package['config']['addonID']
    entry = 'content/scripts/' + package['config']['addonRef'] + '.js'
    driver = (ROOT / 'tests/native-smoke-driver.js').read_text(encoding='utf-8').replace('__NATIVE_REPORT__', json.dumps(str(report)))
    scratch = profile / 'extensions' / (addon_id + '.xpi')
    with ZipFile(release) as source, ZipFile(scratch, 'w') as target:
        for item in source.infolist():
            content = source.read(item.filename)
            if item.filename == entry:
                code = content.decode('utf-8')
                if MARKER in code:
                    raise RuntimeError('A native test driver must never be present in the release build.')
                ending = code.rfind('})();')
                if ending < 0 or code[ending + 5:].strip():
                    raise RuntimeError('Unexpected compiled bundle closure; refusing to patch by guesswork.')
                content = (code[:ending] + '\n// ' + MARKER + '\n' + driver + '\n' + code[ending:]).encode('utf-8')
            target.writestr(item, content)
    preferences = {
        'extensions.autoDisableScopes': 0,
        'extensions.enabledScopes': 15,
        'extensions.zotero.useDataDir': True,
        'extensions.zotero.dataDir': str(library),
        'extensions.zotero.firstRun': False,
        'extensions.zotero.firstRunGuidanceShown': True,
        'browser.shell.checkDefaultBrowser': False,
    }
    (profile / 'user.js').write_text('\n'.join('user_pref(' + json.dumps(key) + ', ' + json.dumps(value) + ');' for key, value in preferences.items()) + '\n', encoding='utf-8')
    assert hashlib.sha256(release.read_bytes()).hexdigest() == release_hash
    receipt = {'profile': str(profile), 'library': str(library), 'report': str(report), 'scratch_xpi': str(scratch),
               'release_sha256': release_hash, 'scratch_sha256': hashlib.sha256(scratch.read_bytes()).hexdigest(),
               'test_only': True, 'provider_credentials_copied': False, 'user_profile_modified': False}
    (home / 'preparation.json').write_text(json.dumps(receipt, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(receipt))
    return home


if __name__ == '__main__':
    argparse.ArgumentParser(description=__doc__).parse_args()
    prepare()
