import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

test("independent menu ids do not mistake an upstream menu for their own", () => {
    const nodes = new Map<string, any>([["#zotero-itemmenu", {}], ["#zotero-itemmenu-pdf2zh", {}]]);
    const registered: any[] = [];
    const preferencePanes: any[] = [];
    const win = { document: { querySelector: (selector: string) => nodes.get(selector) } };
    const source = fs.readFileSync(new URL("../src/modules/pdf2zh.ts", import.meta.url), "utf8");
    const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const exports: any = {};
    const context = { rootURI: "resource://test/", addon: { data: { config: { addonRef: "pdf2zhEasy", addonName: "PDF2zh Easy" } } }, Zotero: { logError() {}, PreferencePanes: { register: (options: any) => preferencePanes.push(options) } },
        ztoolkit: { Menu: { register: (_target: any, options: any) => registered.push(options) } } };
    vm.runInNewContext(`(function(require,exports){${js}\n})`, context)(() => ({ getString: (key: string) => key }), exports);
    exports.PDF2zhBasicFactory.registerPrefs();
    assert.equal(preferencePanes[0].label, "PDF2zh Easy");
    exports.PDF2zhUIFactory.registerRightClickMenuItem(win);
    assert.equal(registered.length, 1);
    assert.equal(registered[0].id, "zotero-itemmenu-pdf2zhEasy");
    assert.ok(registered[0].children.every((item: any) => item.id.startsWith("zotero-itemmenu-pdf2zhEasy-")));
});
