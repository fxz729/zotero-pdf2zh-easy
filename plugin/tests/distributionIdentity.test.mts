import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";

test("fork owns its addon id, chrome namespace, prefs and release origin", () => {
    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    assert.equal(pkg.name, "zotero-pdf2zh-easy");
    assert.equal(pkg.version, "0.1.1");
    assert.equal(pkg.config.addonID, "pdf2zh-easy@fxz729");
    assert.equal(pkg.config.addonRef, "pdf2zhEasy");
    assert.equal(pkg.config.addonInstance, "pdf2zhEasy");
    assert.equal(pkg.config.prefsPrefix, "extensions.zotero.pdf2zhEasy");
    assert.equal(pkg.license, "AGPL-3.0-or-later");
    assert.ok(pkg.scripts.build.includes("audit_release.py --archive-only"));
    assert.match(pkg.homepage, /^https:\/\/github.com\/fxz729\/zotero-pdf2zh-easy/);
    const scaffold = fs.readFileSync(new URL("../zotero-plugin.config.ts", import.meta.url), "utf8");
    assert.ok(scaffold.includes("fxz729/zotero-pdf2zh-easy"));
    assert.ok(!scaffold.includes("github.com/{{owner}}/{{repo}}"));
    assert.ok(scaffold.includes("/releases/latest/download/"));
    const defaults = fs.readFileSync(new URL("../addon/prefs.js", import.meta.url), "utf8");
    assert.ok(defaults.includes('pref("__prefsPrefix__.new_serverip", "http://127.0.0.1:8891")'));
});
