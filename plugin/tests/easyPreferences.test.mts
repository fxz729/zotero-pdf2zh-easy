import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

function setup(initial: Record<string, any> = {}, foreignPaneFirst = false) {
    class Node {
        children: any[] = [];
        attrs: Record<string, string> = {};
        listeners = new Map<string, any>();
        textContent = ""; value = ""; checked = false; disabled = false; hidden = false;
        type = ""; id = ""; style: any = {};
        tagName: string;
        constructor(tagName: string) { this.tagName = tagName; }
        appendChild(n: any) { this.children.push(n); return n; }
        prepend(n: any) { this.children.unshift(n); }
        replaceChildren(...nodes: any[]) { this.children = nodes; }
        setAttribute(key: string, value: string) { this.attrs[key] = value; if (key === "id") this.id = value; }
        addEventListener(key: string, fn: any) { this.listeners.set(key, fn); }
        removeEventListener(key: string, fn: any) { if (this.listeners.get(key) === fn) this.listeners.delete(key); }
        async click() { await this.listeners.get("click")?.({ currentTarget: this }); }
    }
    const all = (node: any): any[] => [node, ...node.children.flatMap(all)];
    const container = new Node("groupbox");
    container.id = "zotero-prefpane-independentTest-group";
    const foreignContainer = new Node("groupbox");
    const doc = { querySelector: () => foreignPaneFirst ? foreignContainer : container, createElementNS: (_ns: string, tag: string) => new Node(tag), getElementById: (id: string) => all(container).find(n => n.id === id) };
    const events = new Map<string, any>();
    const win = { document: doc, addEventListener: (name: string, fn: any) => events.set(name, fn), removeEventListener: (name: string, fn: any) => { if (events.get(name) === fn) events.delete(name); }, confirm: (message: string) => { confirms.push(message); return consent; } };
    const prefs = { ...initial };
    const writes: any[] = [], requests: any[] = [], installs: any[] = [], confirms: string[] = [];
    let consent = true, subscribers = 0, saves = 0, reject = false, legacy = false;
    const status = { phase: "not_installed", version: "1.0", message: "secret-runtime-path" };
    const imports: any = {
        "../../package.json": { config: { addonRef: "independentTest" } },
        "../utils/prefs": { getPref: (key: string) => prefs[key], setPref: (key: string, value: any) => { prefs[key] = value; writes.push([key, value]); } },
        "./managedRuntime": { ManagedRuntime: { readStatus: async () => status, subscribe(fn: any) { subscribers++; fn(status); return () => subscribers--; }, install: async (...args: any[]) => { installs.push(args); if (reject) throw new Error("secret-key-error"); }, ensureReady: async () => { if (reject) throw new Error("secret-key-error"); return true; } } },
        "./preferenceMigration": { hasLegacyPreferences: () => legacy, migrateLegacyPreferences: (accepted: boolean) => { assert.equal(accepted, true); if (reject) throw new Error("secret-key-error"); prefs.llmApis = JSON.stringify([{ key: "imported", service: "openailiked", apiKey: "import-key", apiUrl: "https://import.invalid/v1", model: "import-model", activate: true }]); return 4; } },
    };
    function load(path: string) {
        const url = new URL(path, import.meta.url);
        const source = fs.existsSync(url) ? fs.readFileSync(url, "utf8") : "";
        const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
        const exports: any = {};
        vm.runInNewContext(`(function(require,exports){${js}\n})`, { URL, Zotero: { Utilities: { generateObjectKey: () => "generated" }, HTTP: { request: async (...args: any[]) => { requests.push(args); if (reject) throw new Error("secret-key-error"); return { status: 200, responseText: JSON.stringify({ choices: [{ message: { content: "OK" } }] }) }; } } } })((name: string) => imports[name] || {}, exports);
        return exports;
    }
    imports["./easySettingsModel"] = load("../src/modules/easySettingsModel.ts");
    const ui = load("../src/modules/easyPreferences.ts");
    const start = () => ui.registerEasyPreferences(win, () => saves++);
    const node = (name: string) => doc.getElementById(`zotero-prefpane-independentTest-easy-${name}`);
    const fill = () => { node("url").value = "https://api.example.invalid/v1"; node("key").value = "test-only-key"; node("model").value = "test-model"; };
    return { start, node, fill, prefs, writes, requests, installs, confirms, all: () => all(container), events, status, saves: () => saves, subscribers: () => subscribers, consent: (value: boolean) => consent = value, reject: (value: boolean) => reject = value, legacy: (value: boolean) => legacy = value };
}

test("four sections initialize blank without changing prefs, requesting APIs or installing", async () => {
    const s = setup({ poolSize: 128, qps: 48 });
    assert.equal(typeof s.start, "function");
    s.start();
    assert.equal(s.all().filter(n => n.tagName === "section").length, 4);
    assert.equal(s.node("url").value, "");
    assert.equal(s.node("key").value, "");
    assert.equal(s.node("model").value, "");
    assert.equal(s.node("key").type, "password");
    assert.equal(s.node("preset").value, "keep");
    assert.equal(s.writes.length + s.requests.length + s.installs.length, 0);
    s.start();
    assert.equal(s.all().filter(n => n.tagName === "section").length, 4);
    assert.equal(s.subscribers(), 1);
});

test("settings attach to this addon pane even when another groupbox was loaded first", () => {
    const s = setup({}, true); s.start();
    assert.equal(s.all().filter(n => n.tagName === "section").length, 4);
    assert.ok(s.node("root"));
});

test("API save preserves serialized advanced settings and activates the actual service prefs", async () => {
    const s = setup({ llmApis: JSON.stringify([{ key: "old", service: "openailiked", apiKey: "secret-old", apiUrl: "https://old.invalid/v1", model: "old", activate: true, extraData: { quality: "custom" } }]) });
    s.start();
    assert.equal(s.node("key").value, "");
    s.node("model").value = "new-model";
    await s.node("save-api").click();
    const saved = JSON.parse(s.prefs.llmApis)[0];
    assert.equal(saved.apiKey, "secret-old");
    assert.deepEqual(saved.extraData, { quality: "custom" });
    assert.equal(saved.model, "new-model");
    assert.equal(s.prefs.next_service, "openailiked");
    assert.equal(s.saves(), 1);
    assert.equal(s.requests.length, 0);
    assert.equal(s.all().some(n => n.textContent.includes("secret-old") || n.value === "secret-old"), false);
});

test("API test requires cost consent and validates URL before using safe HTTP flags", async () => {
    const s = setup(); s.start(); s.fill();
    s.consent(false); await s.node("test-api").click();
    assert.equal(s.requests.length, 0);
    assert.match(s.confirms[0], /费用/);
    s.consent(true); s.node("url").value = "http://remote.invalid";
    await s.node("test-api").click(); assert.equal(s.requests.length, 0);
    s.fill(); await s.node("test-api").click();
    assert.equal(s.requests.length, 1);
    const [method, url, options] = s.requests[0];
    assert.equal(method, "POST"); assert.equal(url, "https://api.example.invalid/v1/chat/completions");
    assert.equal(options.debug, false); assert.equal(options.logBodyLength, 0); assert.equal(options.errorDelayMax, 0); assert.equal(options.followRedirects, false);
    assert.equal(JSON.parse(options.body).model, "test-model");
    s.reject(true); await s.node("test-api").click();
    assert.equal(s.node("api-status").textContent.includes("secret-key-error"), false);
});

test("installation and repair require explicit download consent and never stop a running service", async () => {
    const s = setup(); s.start(); s.consent(false);
    await s.node("install").click(); assert.equal(s.installs.length, 0);
    s.consent(true); await s.node("install").click();
    assert.deepEqual(s.installs, [[true, false]]);
    assert.match(s.confirms.at(-1)!, /联网/); assert.match(s.confirms.at(-1)!, /本地执行/); assert.match(s.confirms.at(-1)!, /GB/);
    s.reject(true); await s.node("repair").click();
    assert.deepEqual(s.installs[1], [true, true]);
    assert.match(s.node("runtime-status").textContent, /任务/);
    assert.equal(s.node("runtime-status").textContent.includes("secret-key-error"), false);
});

test("only explicit basic save applies a preset; status and diagnostics contain no secrets", async () => {
    const s = setup({ poolSize: 128, qps: 48, disableGlossary: false, dualMode: "TB" }); s.start();
    assert.equal(s.writes.length, 0);
    s.node("preset").value = "conservative";
    await s.node("save-basic").click();
    assert.equal(s.prefs.poolSize, 8); assert.equal(s.prefs.qps, 4);
    assert.equal(s.prefs.dualMode, "TB"); assert.equal(s.prefs.disableGlossary, false);
    await s.node("diagnose").click();
    assert.equal(s.node("diagnostic").textContent.includes("secret-runtime-path"), false);
    s.events.get("unload")();
    assert.equal(s.subscribers(), 0);
    assert.equal(s.events.size, 0);
});

test("legacy import confirms local secret copying then refreshes the simple and advanced forms", async () => {
    const s = setup(); s.legacy(true); s.start(); s.consent(false);
    await s.node("import").click(); assert.equal(s.prefs.llmApis, undefined);
    s.consent(true); await s.node("import").click();
    assert.match(s.confirms.at(-1)!, /API.*密钥/); assert.match(s.confirms.at(-1)!, /不上传/); assert.match(s.confirms.at(-1)!, /不删除/);
    assert.equal(s.node("model").value, "import-model"); assert.equal(s.node("key").value, "");
    assert.equal(s.saves(), 1);
});

test("advanced preference table masks keys while the editor receives real values and logs no API data", () => {
    const source = fs.readFileSync(new URL("../src/modules/preferenceScript.ts", import.meta.url), "utf8");
    const js = ts.transpileModule(source + "\nexport { getRowData };", { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const exports: any = {}, logs: any[] = [];
    const entry = { key: "old", service: "openailiked", apiKey: "secret-actual", apiUrl: "https://old.invalid", model: "old" };
    vm.runInNewContext(`(function(require,exports){${js}\n})`, { addon: { data: { llmApis: { map: new Map([["old", entry]]), cachedKeys: ["old"] } } }, Zotero: {}, ztoolkit: { log: (...args: any[]) => logs.push(args) } })((name: string) => name === "../../package.json" ? { config: {} } : name === "../utils/prefs" ? { getPref: () => JSON.stringify([entry]) } : name === "./llmApiManager" ? { llmApiManager: { updateLLMApi() {} }, formatExtraDataForDisplay: () => "" } : {}, exports);
    assert.equal(exports.getRowData(0).apiKey, "••••••••");
    exports.loadLLMApisFromPrefs();
    assert.equal(JSON.stringify(logs).includes("secret-actual"), false);
    assert.match(source, /apiKey: llmApi\.apiKey \|\| ""/);
});
