import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const key = "synthetic-plugin-provider-U6J8";
const header = "synthetic-plugin-header-P9L2";
const credentials = () => ({ service: "openai", model: "test-model", apiUrl: "https://synthetic.invalid/v1", apiKey: key,
    extraData: { headers: { Authorization: `Bearer ${header}` } } });

function setup(reply: { text: string; ok: boolean; status: number } = { text: "", ok: false, status: 500 }) {
    const logs: unknown[][] = [];
    const requests: any[] = [];
    const sandbox = vm.createContext({ console, Error, setTimeout,
        ztoolkit: { log: (...args: unknown[]) => logs.push(args), getGlobal: () => () => {} },
        Zotero: { Promise: { delay: async () => {} } } });
    function evaluate(source: string, imports: Record<string, any> = {}) {
        const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
        const exports: any = {};
        vm.runInContext(`(function(require,exports){${js}\n})`, sandbox)((name: string) => imports[name] || {}, exports);
        return exports;
    }
    const path = new URL("../src/modules/privacy.ts", import.meta.url);
    const Privacy = fs.existsSync(path) ? evaluate(fs.readFileSync(path, "utf8")).Privacy : {
        register() {}, text: (value: unknown) => String(value), json: (value: unknown) => value,
        log: (...args: unknown[]) => logs.push(args),
    };
    const factory = evaluate(fs.readFileSync(new URL("../src/modules/pdf2zhHelper.ts", import.meta.url), "utf8"), {
        "./privacy": { Privacy },
        "../utils/locale": { getString: (message: string) => message },
        "./managedRuntime": { ManagedRuntime: { fetch: async (url: string, options: any) => {
            requests.push({ url, ...options });
            return { ok: reply.ok, status: reply.status, text: async () => reply.text };
        } } },
        "../../package.json": { version: "synthetic" },
    }).PDF2zhHelperFactory;
    factory.getActiveLLMApiConfig = credentials;
    return { Privacy, factory, logs, requests };
}

test("registered API keys and nested headers are removed from diagnostics without mutating originals", () => {
    const { Privacy } = setup();
    const actual = credentials();
    const before = JSON.stringify(actual);
    Privacy.register(actual);
    const clean = Privacy.json({ message: `upstream echoed ${key}`, headers: actual.extraData.headers, config: actual });
    assert.equal(JSON.stringify(actual), before);
    assert.notEqual(clean.config, actual);
    assert.ok(!JSON.stringify(clean).includes(key));
    assert.ok(!JSON.stringify(clean).includes(header));
    assert.match(clean.message, /upstream echoed/);
    for (const text of ["Authorization: Bearer unregistered-token", "api_key=unregistered-key", "https://user:unregistered-password@synthetic.invalid?token=unregistered-query"]) {
        const result = Privacy.text(text);
        for (const value of ["unregistered-token", "unregistered-key", "unregistered-password", "unregistered-query"]) assert.ok(!result.includes(value));
    }
});

test("diagnostic copies hide unknown extraData values and secret property names", () => {
    const { Privacy } = setup();
    Privacy.register(credentials());
    const input = { [key]: "provider error", extraData: { opaque_setting: "synthetic-opaque-extra-N7B3" } };
    const before = JSON.stringify(input);
    const output = JSON.stringify(Privacy.json(input));
    assert.ok(!output.includes(key));
    assert.ok(!output.includes("synthetic-opaque-extra-N7B3"));
    assert.equal(JSON.stringify(input), before);
});

test("JSON-string extra headers register opaque values for later bare provider errors", () => {
    const { Privacy } = setup();
    const value = "synthetic-json-header-Z4S6";
    Privacy.register({ extraData: { vendor_options: JSON.stringify({ headers: { "X-Custom": value } }) } });
    assert.ok(!Privacy.text(`upstream: ${value}`).includes(value));
});

test("malformed server response bodies are not dumped or used as error messages", async () => {
    const s = setup({ text: `opaque-response-marker ${key} Authorization: Bearer ${header}`, ok: false, status: 502 });
    await assert.rejects(s.factory.sendRequest({ fileName: "synthetic.pdf", base64: "SYNTHETIC_PDF_BYTES" },
        { serverUrl: "http://127.0.0.1:8891", engine: "pdf2zh_next", next_service: "openai" }, "translate"), (error: Error) => {
        assert.ok(!error.message.includes(key));
        assert.ok(!error.message.includes(header));
        assert.ok(!error.message.includes("opaque-response-marker"));
        assert.match(error.message, /502/);
        return true;
    });
    const log = JSON.stringify(s.logs);
    assert.ok(!log.includes(key));
    assert.ok(!log.includes(header));
    assert.ok(!log.includes("opaque-response-marker"));
    const sent = JSON.parse(s.requests[0].body);
    assert.equal(sent.llm_api.apiKey, key);
    assert.equal(sent.llm_api.extraData.headers.Authorization, `Bearer ${header}`);
    assert.equal(sent.fileContent, "SYNTHETIC_PDF_BYTES");
});

test("server JSON errors are redacted while useful failure text remains", async () => {
    const s = setup({ text: JSON.stringify({ status: "error", message: `provider rejected ${key}` }), ok: false, status: 401 });
    await assert.rejects(s.factory.sendRequest({ fileName: "synthetic.pdf", base64: "SYNTHETIC_PDF_BYTES" },
        { serverUrl: "http://127.0.0.1:8891", engine: "pdf2zh_next", next_service: "openai" }, "translate"), (error: Error) => {
        assert.ok(!error.message.includes(key));
        assert.match(error.message, /provider rejected/);
        return true;
    });
    assert.ok(!JSON.stringify(s.logs).includes(key));
});

test("history failures and diagnostic summaries redact credentials without changing task objects", () => {
    const s = setup();
    s.Privacy.register(credentials());
    const task = { taskId: "synthetic-task", finished: true, status: "failed", error: `provider rejected ${key}` };
    const original = JSON.stringify(task);
    const result = s.factory.completedTaskPayload(task, "synthetic-task");
    assert.ok(!result.message.includes(key));
    assert.equal(JSON.stringify(task), original);
    assert.ok(!s.factory.shortProgressError(`request error ${header}`).includes(header));
});
