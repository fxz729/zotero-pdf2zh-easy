import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

function setup(fail = false) {
    const order: string[] = [];
    const source = fs.readFileSync(new URL("../src/modules/pdf2zhHelper.ts", import.meta.url), "utf8");
    const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const exports: any = {};
    const context = { ztoolkit: { log() {}, getGlobal: () => () => {} } };
    const imports: any = {
        "../utils/locale": { getString: (key: string) => key },
        "./runtimeManifest": { SERVICE_URL: "http://127.0.0.1:8891" },
        "./managedRuntime": { ManagedRuntime: { ensureReady: async () => { order.push("ensure"); if (fail) throw new Error("service unavailable"); return true; } } },
    };
    vm.runInNewContext(`(function(require,exports){${js}\n})`, context)((name: string) => imports[name] || {}, exports);
    const factory = exports.PDF2zhHelperFactory;
    factory.prepareFileData = async () => { order.push("readPDF"); return { fileName: "synthetic.pdf", base64: "" }; };
    factory.sendRequest = async (_file: any, config: any) => { order.push("submit"); assert.equal(config.serverUrl, "http://127.0.0.1:8891"); return {}; };
    factory.handleResponse = async () => { order.push("import"); };
    return { factory, order };
}

test("helper authenticates readiness before reading or submitting a PDF and canonicalizes localhost", async () => {
    const s = setup();
    await s.factory.processSingleFile({ fileName: "synthetic.pdf", item: {}, config: { serverUrl: "http://localhost:8891" }, endpoint: "translate" });
    assert.deepEqual(s.order, ["ensure", "readPDF", "submit", "import"]);
});

test("failed readiness never reads a PDF or sends provider credentials", async () => {
    const s = setup(true);
    await assert.rejects(s.factory.processSingleFile({ fileName: "synthetic.pdf", item: {}, config: { serverUrl: "http://localhost:8891" }, endpoint: "translate" }));
    assert.deepEqual(s.order, ["ensure"]);
});
