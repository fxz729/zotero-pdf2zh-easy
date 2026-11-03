import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

function setup(initial: Record<string, any> = {}) {
    const values = new Map(Object.entries(initial));
    const old = "extensions.zotero.pdf2zh.";
    const fresh = "extensions.zotero.pdf2zhEasy.";
    const writes: any[] = [];
    const source = fs.readFileSync(new URL("../src/modules/preferenceMigration.ts", import.meta.url), "utf8");
    const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const exports: any = {};
    vm.runInNewContext(`(function(require,exports){${js}\n})`, {
        Services: { prefs: { getChildList: (prefix: string) => [...values.keys()].filter(k => k.startsWith(prefix)), prefHasUserValue: (key: string) => values.has(key) } },
        Zotero: { Prefs: { get: (key: string) => values.get(key), set: (key: string, value: any) => { writes.push([key, value]); values.set(key, value); }, clear: (key: string) => values.delete(key) } },
    })((name: string) => name.endsWith("package.json") ? { config: { prefsPrefix: "extensions.zotero.pdf2zhEasy" } } : { SERVICE_URL: "http://127.0.0.1:8891" }, exports);
    return { ...exports, old, fresh, values, writes };
}

test("migration requires explicit consent and does not touch either namespace without it", () => {
    const s = setup({ "extensions.zotero.pdf2zh.qps": "48" });
    assert.throws(() => s.migrateLegacyPreferences(false), /consent/i);
    assert.equal(s.writes.length, 0);
});

test("copies saved API and quality settings exactly without logging or changing the old profile", () => {
    const api = JSON.stringify([{ key: "config-id", service: "openailiked", model: "deepseek-flash", apiKey: "synthetic-secret", extraData: { openai_reasoning_effort: "none" } }]);
    const s = setup({
        "extensions.zotero.pdf2zh.llmApis": api,
        "extensions.zotero.pdf2zh.threadNum": "128",
        "extensions.zotero.pdf2zh.poolSize": "128",
        "extensions.zotero.pdf2zh.qps": "48",
        "extensions.zotero.pdf2zh.disableGlossary": true,
        "extensions.zotero.pdf2zh.new_serverip": "http://127.0.0.1:8890",
        "extensions.other.private": "unrelated",
    });
    assert.equal(s.hasLegacyPreferences(), true);
    const count = s.migrateLegacyPreferences(true);
    assert.equal(typeof count, "number");
    assert.equal(s.values.get(s.fresh + "llmApis"), api);
    assert.equal(s.values.get(s.fresh + "qps"), "48");
    assert.equal(s.values.get(s.fresh + "poolSize"), "128");
    assert.equal(s.values.get(s.fresh + "disableGlossary"), true);
    assert.equal(s.values.get(s.fresh + "new_serverip"), "http://127.0.0.1:8891");
    assert.equal(s.values.get(s.old + "new_serverip"), "http://127.0.0.1:8890");
    assert.ok(s.writes.every(([key]: any) => key.startsWith(s.fresh)));
});

test("never overwrites a new user's existing API profile", () => {
    const s = setup({ "extensions.zotero.pdf2zh.llmApis": "[]", "extensions.zotero.pdf2zhEasy.llmApis": '[{"model":"existing"}]' });
    assert.throws(() => s.migrateLegacyPreferences(true), /existing/i);
    assert.equal(s.writes.length, 0);
});

test("no legacy user prefs yields no changes instead of copying defaults", () => {
    const s = setup();
    assert.equal(s.hasLegacyPreferences(), false);
    assert.equal(s.migrateLegacyPreferences(true), 0);
    assert.equal(s.writes.length, 0);
});
