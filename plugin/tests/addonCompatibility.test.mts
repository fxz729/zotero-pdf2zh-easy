import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

function load(original: any, failure = false) {
    const source = fs.readFileSync(new URL("../src/modules/addonCompatibility.ts", import.meta.url), "utf8");
    const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const exports: any = {};
    vm.runInNewContext(`(function(exports){${js}\n})`, {
        ChromeUtils: { importESModule: () => { if (failure) throw new Error("internal details"); return { AddonManager: { getAddonByID: async (id: string) => { assert.equal(id, "pdf2zh@guaguastandup.com"); return original; } } }; } },
    })(exports);
    return exports.assertNoOriginalAddonConflict;
}

test("active upstream addon is detected but never silently disabled", async () => {
    let disableCalls = 0;
    const check = load({ isActive: true, disable: () => { disableCalls++; } });
    await assert.rejects(check(), /Disable the original/i);
    assert.equal(disableCalls, 0);
});

test("missing or disabled upstream addon allows the independent distribution", async () => {
    await load(null)();
    await load({ isActive: false })();
});

test("compatibility lookup failure is generic and fails closed", async () => {
    await assert.rejects(load(null, true)(), /^Error: Addon compatibility could not be verified\.$/);
});
