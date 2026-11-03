import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const url = new URL("../src/modules/easySettingsModel.ts", import.meta.url);
const source = fs.existsSync(url) ? fs.readFileSync(url, "utf8") : "";
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const model: any = {};
vm.runInNewContext(`(function(exports){${js}\n})`, { URL })(model);
const input = { apiUrl: "https://api.example.invalid/v1/", apiKey: "test-only-key", model: "test-model" };
const plain = (value: any) => JSON.parse(JSON.stringify(value));

test("validates HTTPS or loopback APIs without returning secret-bearing errors", () => {
    assert.equal(typeof model.validateApiInput, "function");
    assert.equal(model.validateApiInput(input).apiUrl, "https://api.example.invalid/v1");
    for (const apiUrl of ["http://localhost:8000/v1", "http://127.0.0.1:8000/v1", "http://[::1]:8000/v1"]) {
        assert.equal(model.validateApiInput({ ...input, apiUrl }).apiUrl, apiUrl);
    }
    for (const apiUrl of ["http://api.example.invalid/v1", "https://user:password@example.invalid", "https://example.invalid?key=secret", "https://example.invalid#secret", "file:///test", "https://example.invalid\n/"]) {
        assert.throws(() => model.validateApiInput({ ...input, apiUrl }), error => !String(error).includes("password") && !String(error).includes("secret"));
    }
    assert.throws(() => model.validateApiInput({ ...input, model: " " }));
    assert.throws(() => model.validateApiInput({ ...input, apiKey: "key\r\nInjected: true" }));
});

test("saving existing serialized API preserves advanced fields and the untouched key", () => {
    const entries = [{ key: "old", service: "deepseek", apiKey: "keep-key", apiUrl: "https://old.invalid", model: "old-model", activate: true, quality: "custom", extraData: { temperature: 0.2, deepseek_reasoning_effort: "max", nested: { a: 1 } } }, { key: "other", service: "openai", apiKey: "other-key", model: "other", activate: true }];
    const raw = JSON.stringify(entries);
    const result = model.saveEasyApi(raw, { ...input, apiKey: "" }, "old", "unused");
    assert.equal(result.profile.apiKey, "keep-key");
    assert.equal(result.profile.service, "deepseek");
    assert.equal(result.profile.quality, "custom");
    assert.deepEqual(plain(result.profile.extraData), entries[0].extraData);
    assert.deepEqual(JSON.parse(result.serialized)[1], entries[1]);
    assert.equal(raw, JSON.stringify(entries));
});

test("new profiles use the upstream contract and nonreasoning defaults, activating only their service", () => {
    const result = model.saveEasyApi(JSON.stringify([{ key: "old", service: "openailiked", activate: true, extraData: { quality: "untouched" } }, { key: "other", service: "openai", activate: true }]), input, "", "new");
    const entries = JSON.parse(result.serialized);
    assert.equal(result.profile.service, "openailiked");
    assert.equal(result.profile.key, "new");
    assert.equal(result.profile.activate, true);
    assert.equal(result.profile.extraData.openai_compatible_reasoning_effort, "none");
    assert.equal(result.profile.extraData.openai_compatible_send_reasoning_effort, true);
    assert.equal(entries[0].activate, false);
    assert.deepEqual(entries[0].extraData, { quality: "untouched" });
    assert.equal(entries[1].activate, true);
});

test("invalid serialized data and removed selections never overwrite preferences", () => {
    assert.equal(typeof model.saveEasyApi, "function");
    for (const raw of ["not-json", "{}", "[null]"]) assert.throws(() => model.saveEasyApi(raw, input, "", "new"));
    assert.throws(() => model.saveEasyApi("[]", input, "removed", "new"));
    assert.throws(() => model.saveEasyApi("[]", { ...input, apiKey: "" }, "", "new"));
});

test("explicit presets only patch basic preferences, never advanced quality settings", () => {
    assert.deepEqual(plain(model.translationPreferences({ preset: "conservative", sourceLang: "en", targetLang: "zh-CN", dualMode: "LR", disableGlossary: true })), { poolSize: 8, qps: 4, sourceLang: "en", targetLang: "zh-CN", dualMode: "LR", disableGlossary: true });
    assert.equal(model.translationPreferences({ preset: "fast", sourceLang: "en", targetLang: "zh-CN", dualMode: "TB", disableGlossary: false }).poolSize, 128);
    assert.equal(model.translationPreferences({ preset: "fast", sourceLang: "en", targetLang: "zh-CN", dualMode: "TB", disableGlossary: false }).qps, 48);
    assert.equal("poolSize" in model.translationPreferences({ preset: "keep", sourceLang: "en", targetLang: "ja", dualMode: "LR", disableGlossary: true }), false);
    assert.throws(() => model.translationPreferences({ preset: "other", sourceLang: "en", targetLang: "ja", dualMode: "LR", disableGlossary: true }));
});

test("new-profile defaults use eight workers and four QPS without a prefilled API", () => {
    const defaults: any = {};
    vm.runInNewContext(fs.readFileSync(new URL("../addon/prefs.js", import.meta.url), "utf8"), { pref: (key: string, value: any) => defaults[key.split(".").at(-1)!] = value });
    assert.equal(defaults.poolSize, 8);
    assert.equal(defaults.threadNum, 8);
    assert.equal(defaults.qps, 4);
    assert.equal(defaults.disableGlossary, true);
    assert.equal(defaults.next_service, "openailiked");
    assert.equal(defaults.llmApis, undefined);
});

test("masking and diagnostics omit keys, URLs, model names and raw runtime messages", () => {
    assert.equal(model.maskApiKey("secret"), "••••••••");
    assert.equal(model.maskApiKey(""), "");
    const diagnostic = model.safeDiagnostics({ phase: "error", version: "1.0", message: "secret https://private.invalid C:/private" }, { poolSize: 8, qps: 4, apiKey: "secret", apiUrl: "https://private.invalid" });
    assert.equal(/secret|private|apiKey|apiUrl/.test(diagnostic), false);
    assert.match(diagnostic, /8/);
    assert.equal(model.safeDiagnostics({ phase: "secret", version: "secret" }, {}).includes("secret"), false);
    assert.equal(model.runtimeLabel({ phase: "constructor" }), "状态待检查");
});
