import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

function setup(serverUrl = "http://127.0.0.1:8891", locale = "en-US") {
    const entry = { key: "synthetic-profile", service: "openailiked", model: "synthetic-model", apiKey: "synthetic-editor-key",
        apiUrl: "https://synthetic.invalid/v1", activate: true, extraData: {} as Record<string, unknown> };
    const prefs = new Map<string, unknown>([["new_serverip", serverUrl]]);
    const ensured: string[] = [], requests: any[] = [], alerts: string[] = [], logs: any[] = [], dialogs: any[] = [], timers: Array<() => void> = [];
    let ready: boolean | Error = true, windows = 0, statusReads = 0;
    const sandbox = vm.createContext({
        addon: { data: { llmApis: { map: new Map([[entry.key, entry]]), cachedKeys: [entry.key] } } },
        Zotero: { locale, Utilities: { generateObjectKey: () => "synthetic-generated-key" },
            Promise: { defer: () => ({ promise: Promise.resolve(), resolve() {} }) },
            getMainWindow: () => ({ openDialog: (_url: string, _name: string, _flags: string, args: any) => { dialogs.push(args.data); return { closed: true }; } }),
        },
        ztoolkit: { log: (...args: any[]) => logs.push(args), getGlobal: () => (message: unknown) => alerts.push(String(message)),
            ProgressWindow: class {
                constructor() { windows++; }
                createLine() { return this; }
                show() {}
                changeLine() {}
                close() {}
            },
        },
        setTimeout: (callback: () => void) => { timers.push(callback); return timers.length; },
    });
    function load(source: string, imports: Record<string, any> = {}) {
        const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
        const exports: any = {};
        vm.runInContext(`(function(require,exports){${js}\n})`, sandbox)((name: string) => imports[name] || {}, exports);
        return exports;
    }
    // Real manager/formatter module, not the historical empty formatter stub.
    const manager = load(fs.readFileSync(new URL("../src/modules/llmApiManager.ts", import.meta.url), "utf8"));
    const imports = {
        "../../package.json": { config: { addonRef: "syntheticTest" } },
        "../utils/prefs": { getPref: (key: string) => prefs.get(key), setPref: (key: string, value: unknown) => prefs.set(key, value) },
        "./llmApiManager": manager,
        "./managedRuntime": { ManagedRuntime: {
            ensureReady: async (url: string) => { ensured.push(url); if (ready instanceof Error) throw ready; return ready; },
            readStatus: async () => { statusReads++; return { phase: "ready", version: "synthetic" }; },
        } },
        axios: { default: { get: async (...args: any[]) => { requests.push(args); return { status: 200, data: { status: "ok", version: "synthetic-public" } }; }, isAxiosError: () => false } },
    };
    const source = fs.readFileSync(new URL("../src/modules/preferenceScript.ts", import.meta.url), "utf8")
        + "\nexport { getRowData, checkServerConnection, openLLMApiEditDialog, saveLLMApisToPrefs };";
    const api = load(source, imports);
    return { ...api, entry, prefs, ensured, requests, alerts, logs, dialogs,
        ready: (value: boolean | Error) => { ready = value; },
        windows: () => windows, statusReads: () => statusReads,
        finishTimers: () => { while (timers.length) timers.shift()!(); },
    };
}

test("managed advanced connection checks use authoritative readiness without raw health HTTP or native progress windows", async () => {
    for (const url of ["http://127.0.0.1:8891", "http://localhost:8891/", "HTTP://LOCALHOST:8891"]) {
        const s = setup(url);
        await s.checkServerConnection(); s.finishTimers();
        assert.deepEqual(s.ensured, [url]);
        assert.equal(s.requests.length, 0);
        assert.equal(s.windows(), 0);
        assert.equal(s.statusReads(), 0);
        assert.ok(s.alerts.some(message => /identity verified|身份校验/.test(message)));
    }
});

test("managed identity failure cannot become success from cached ready state or legacy health", async () => {
    const s = setup(); s.ready(new Error("synthetic-private-auth-error"));
    await s.checkServerConnection(); s.finishTimers();
    assert.equal(s.ensured.length, 1);
    assert.equal(s.requests.length, 0);
    assert.equal(s.windows(), 0);
    assert.equal(s.statusReads(), 0);
    assert.ok(s.alerts.some(message => /unable|could not|无法/i.test(message)));
    assert.ok(!s.alerts.some(message => /identity verified|Connected successfully/.test(message)));
    assert.ok(!JSON.stringify([s.alerts, s.logs]).includes("synthetic-private-auth-error"));
});

test("managed false readiness is rejected rather than reported as authenticated success", async () => {
    const s = setup(); s.ready(false);
    await s.checkServerConnection(); s.finishTimers();
    assert.equal(s.requests.length, 0);
    assert.ok(s.alerts.some(message => /unable|could not|无法/i.test(message)));
    assert.ok(!s.alerts.some(message => /identity verified|Connected successfully/.test(message)));
});

test("explicit remote and other-port manual servers preserve the legacy health protocol", async () => {
    for (const url of ["https://synthetic.invalid:1188", "http://127.0.0.1:8890"]) {
        const s = setup(url);
        await s.checkServerConnection(); s.finishTimers();
        assert.equal(s.ensured.length, 0);
        assert.equal(s.requests.length, 1);
        assert.equal(s.requests[0][0], url + "/health");
        assert.equal(s.requests[0][1].timeout, 10000);
        assert.equal(s.windows(), 1);
        assert.ok(s.alerts.some(message => /Connected successfully/.test(message)));
    }
});

test("advanced extraData shows only localized field counts, never names or short/long credential values", () => {
    for (const locale of ["en-US", "zh-CN"]) {
        const s = setup(undefined, locale);
        const extra = { Authorization: "tiny", custom_api_key: "synthetic-long-secret-value", "synthetic-private-field-name": "another", headers: { "X-Custom": "synthetic-nested-header" } };
        s.entry.extraData = extra;
        const before = JSON.stringify(s.entry);
        const row = s.getRowData(0);
        assert.equal(row.apiKey, "••••••••");
        assert.equal(row.extraData, locale === "zh-CN" ? "已配置 4 项" : "4 configured fields");
        for (const value of [...Object.keys(extra), "tiny", "synthetic-", "another", "X-Custom"]) assert.ok(!row.extraData.includes(value));
        assert.equal(JSON.stringify(s.entry), before);
        assert.equal(s.entry.extraData, extra);
    }
});

test("empty extraData remains blank", () => {
    const s = setup();
    assert.equal(s.getRowData(0).extraData, "");
});

test("table display cannot change the actual editor, saved JSON, or engine configuration object", async () => {
    const s = setup();
    const extra = { Authorization: "synthetic-full-authorization", quality: "synthetic-quality-setting" };
    s.entry.extraData = extra;
    const before = JSON.stringify(s.entry);
    s.getRowData(0);
    s.saveLLMApisToPrefs();
    const saved = JSON.parse(String(s.prefs.get("llmApis")))[0];
    assert.equal(JSON.stringify(saved), before);
    await s.openLLMApiEditDialog(s.entry.key);
    assert.equal(s.dialogs.length, 1);
    assert.equal(s.dialogs[0].apiKey, s.entry.apiKey);
    assert.equal(s.dialogs[0].extraData, extra);
    assert.equal(JSON.stringify(s.entry), before);
    assert.equal(s.entry.extraData, extra);
});
