import { config } from "../../package.json";
import { getPref, setPref } from "../utils/prefs";
import { ManagedRuntime, type RuntimeStatus } from "./managedRuntime";
import { hasLegacyPreferences, migrateLegacyPreferences } from "./preferenceMigration";
import { readEasyApis, saveEasyApi, translationPreferences, runtimeLabel, safeDiagnostics } from "./easySettingsModel";

const HTML = "http://www.w3.org/1999/xhtml";

// Deliberately no network, preference writes, or installation on page load.
export function registerEasyPreferences(win: Window, onSaved: () => void): void {
    const doc = win.document;
    const prefix = `zotero-prefpane-${config.addonRef}-easy-`;
    if (doc.getElementById(prefix + "root")) return;
    const container = doc.getElementById(`zotero-prefpane-${config.addonRef}-group`);
    if (!container) return;
    let alive = true;
    let currentStatus: RuntimeStatus = { phase: "not_installed", message: "", version: "" };
    const listeners: Array<() => void> = [];
    function element<K extends keyof HTMLElementTagNameMap>(tag: K, text = "", name = ""): HTMLElementTagNameMap[K] {
        const node = doc.createElementNS(HTML, tag) as HTMLElementTagNameMap[K];
        node.textContent = text;
        if (name) node.id = prefix + name;
        return node;
    }
    const root = element("div", "", "root");
    root.setAttribute("class", "pdf2zh-easy-settings");
    const style = element("style", `
.pdf2zh-easy-settings { --easy-accent:#267c70; color:inherit; margin:0 0 28px; font:inherit; }
.pdf2zh-easy-settings section { border:1px solid #ccd5ce; border-radius:10px; padding:18px 20px; margin:12px 0; background:#fafbf8; color:#243a38; }
.pdf2zh-easy-settings h2 { font-size:20px; margin:0 0 4px; }
.pdf2zh-easy-settings h3 { font-size:15px; margin:0 0 12px; color:var(--easy-accent); }
.pdf2zh-easy-settings p { margin:8px 0; line-height:1.6; }
.pdf2zh-easy-settings .easy-field { display:grid; grid-template-columns:150px minmax(120px,1fr); align-items:center; gap:12px; margin:10px 0; }
.pdf2zh-easy-settings input:not([type=checkbox]), .pdf2zh-easy-settings select { min-width:0; box-sizing:border-box; width:100%; padding:6px 8px; border:1px solid #9faeaa; border-radius:5px; font:inherit; background:Field; color:FieldText; }
.pdf2zh-easy-settings input[type=checkbox] { justify-self:start; }
.pdf2zh-easy-settings button { padding:6px 12px; margin:6px 8px 4px 0; font:inherit; cursor:pointer; border:1px solid #80958e; border-radius:5px; background:ButtonFace; color:ButtonText; }
.pdf2zh-easy-settings button:disabled { opacity:.55; cursor:wait; }
.pdf2zh-easy-settings :focus-visible { outline:2px solid var(--easy-accent); outline-offset:2px; }
.pdf2zh-easy-settings .easy-status { min-height:1.5em; overflow-wrap:anywhere; }
.pdf2zh-easy-settings pre { white-space:pre-wrap; overflow-wrap:anywhere; font-size:12px; }
@media (prefers-color-scheme:dark) { .pdf2zh-easy-settings { --easy-accent:#88d0b9; } .pdf2zh-easy-settings section { background:#242c2b; color:#e4ece6; border-color:#46534c; } }
@media (max-width:520px) { .pdf2zh-easy-settings .easy-field { grid-template-columns:1fr; gap:4px; } }
`);
    root.appendChild(style);
    root.appendChild(element("h2", "PDF2zh Easy · 开始翻译"));
    root.appendChild(element("p", "填入自己的 API，安装一次引擎，之后在文献右键菜单中翻译。下方原版高级设置完整保留。"));
    container.prepend(root);
    function section(title: string): HTMLElement {
        const section = element("section");
        section.appendChild(element("h3", title)); root.appendChild(section); return section;
    }
    function input(parent: HTMLElement, name: string, label: string, type = "text"): HTMLInputElement {
        const row = element("div"); row.setAttribute("class", "easy-field");
        const caption = element("label", label); caption.setAttribute("for", prefix + name);
        const field = element("input", "", name); field.type = type;
        row.appendChild(caption); row.appendChild(field); parent.appendChild(row); return field;
    }
    function select(parent: HTMLElement, name: string, label: string, options: Array<[string, string]>): HTMLSelectElement {
        const row = element("div"); row.setAttribute("class", "easy-field");
        const caption = element("label", label); caption.setAttribute("for", prefix + name);
        const field = element("select", "", name);
        for (const [value, text] of options) { const option = element("option", text); option.value = value; field.appendChild(option); }
        row.appendChild(caption); row.appendChild(field); parent.appendChild(row); return field;
    }
    function listen(node: EventTarget, event: string, handler: EventListener): void {
        node.addEventListener(event, handler);
        listeners.push(() => node.removeEventListener(event, handler));
    }
    function button(parent: HTMLElement, name: string, text: string, handler: () => Promise<void> | void): HTMLButtonElement {
        const button = element("button", text, name); button.type = "button";
        listen(button, "click", async () => {
            if (button.disabled || !alive) return;
            button.disabled = true;
            try { await handler(); } finally { if (alive) button.disabled = false; }
        });
        parent.appendChild(button); return button;
    }
    function status(parent: HTMLElement, name: string): HTMLElement {
        const node = element("p", "", name); node.setAttribute("class", "easy-status"); node.setAttribute("role", "status"); node.setAttribute("aria-live", "polite"); parent.appendChild(node); return node;
    }
    const api = section("01 / API 配置");
    const profile = select(api, "profile", "配置", []);
    const url = input(api, "url", "API Base URL"); url.placeholder = "https://服务商地址/v1";
    const key = input(api, "key", "API Key", "password"); key.setAttribute("autocomplete", "new-password");
    const model = input(api, "model", "模型名称"); model.placeholder = "按服务商文档填写";
    api.appendChild(element("p", "本页测试针对 OpenAI 兼容接口；其他协议请使用下方高级编辑器。密钥沿用上游方式保存在本机 Zotero 偏好设置，不是加密保险库。新配置默认 reasoning none；已有配置的高级质量参数不会被覆盖。"));
    const apiStatus = status(api, "api-status");
    const form = () => ({ apiUrl: url.value, apiKey: key.value, model: model.value });
    function fillProfile(): void {
        try {
            const selected = readEasyApis(getPref("llmApis")).find(entry => entry.key === profile.value);
            url.value = selected?.apiUrl || ""; model.value = selected?.model || ""; key.value = "";
            key.placeholder = selected?.apiKey ? "已保存；留空保留现有密钥" : "填写自己的密钥";
        } catch { apiStatus.textContent = "无法读取配置，请检查下方高级设置；原配置未修改。"; }
    }
    function refresh(): void {
        try {
            const entries = readEasyApis(getPref("llmApis"));
            const options = [["", "新建 OpenAI 兼容配置"], ...entries.map(entry => [entry.key, `${entry.service} · ${entry.model}`])];
            profile.replaceChildren();
            for (const [value, text] of options) { const option = element("option", text); option.value = value; profile.appendChild(option); }
            profile.value = entries.find(entry => entry.activate && entry.service === getPref("next_service"))?.key || entries.find(entry => entry.activate)?.key || "";
            fillProfile();
        } catch { apiStatus.textContent = "无法读取配置，请检查下方高级设置；原配置未修改。"; }
    }
    listen(profile, "change", fillProfile);
    button(api, "save-api", "保存并启用 API", () => {
        try {
            const result = saveEasyApi(getPref("llmApis"), form(), profile.value, Zotero.Utilities.generateObjectKey());
            setPref("llmApis", result.serialized);
            setPref("next_service", result.profile.service); setPref("service", result.profile.service);
            onSaved(); refresh(); apiStatus.textContent = "已保存并启用。密钥不会显示在表格或诊断中。";
        } catch { apiStatus.textContent = "保存失败：请检查 HTTPS 地址、密钥、模型及高级配置格式；原 API 配置未覆盖。"; }
    });
    button(api, "test-api", "测试 API 连接…", async () => {
        if (!win.confirm("连接测试会向您填写的服务商发送一条简短请求，可能产生少量 API 费用。是否继续？")) return;
        try {
            const { profile: candidate } = saveEasyApi(getPref("llmApis"), form(), profile.value, "connection-test");
            apiStatus.textContent = "正在测试，最多等待 20 秒…";
            const response = await Zotero.HTTP.request("POST", candidate.apiUrl + "/chat/completions", {
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${candidate.apiKey}` },
                body: JSON.stringify({ model: candidate.model, messages: [{ role: "user", content: "Reply OK." }], max_tokens: 8, stream: false,
                    ...(candidate.service === "openailiked" && candidate.extraData?.openai_compatible_send_reasoning_effort ? { reasoning_effort: candidate.extraData.openai_compatible_reasoning_effort } : {}),
                }), timeout: 20000, followRedirects: false, debug: false, logBodyLength: 0, errorDelayMax: 0,
            });
            const data = JSON.parse(response.responseText);
            if (response.status < 200 || response.status >= 300 || !Array.isArray(data?.choices) || !data.choices[0]?.message) throw new Error();
            if (alive) apiStatus.textContent = "API 连接成功。测试未保存配置；请点击保存以用于翻译。";
        } catch { if (alive) apiStatus.textContent = "连接测试失败。请核对地址、密钥、模型、余额和网络；未显示敏感请求或服务商响应。"; }
    });
    const engine = section("02 / 翻译引擎");
    engine.appendChild(element("p", "首次安装会联网下载 Python 和依赖并在本机执行，可能占用数 GB 磁盘。之后按需启动，无需终端。"));
    const runtimeStatus = status(engine, "runtime-status");
    const showRuntime = (value: RuntimeStatus) => { currentStatus = value; if (alive) runtimeStatus.textContent = runtimeLabel(value); };
    async function install(repair: boolean): Promise<void> {
        if (!win.confirm(`${repair ? "修复" : "安装"}引擎将联网下载 Python 和依赖，在隔离目录中本地执行，可能需要数 GB 磁盘和几分钟时间。${repair ? "运行中的服务不会被强制停止，请等待翻译任务完成；服务运行时修复会拒绝。" : ""}是否继续？`)) return;
        try { await ManagedRuntime.install(true, repair); if (alive) showRuntime(await ManagedRuntime.readStatus()); }
        catch { if (alive) runtimeStatus.textContent = "操作未完成：请检查网络和安装状态。修复不会停止服务，请先等待任务完成，勿强制终止任务。"; }
    }
    button(engine, "install", "下载安装引擎…", () => install(false));
    button(engine, "repair", "修复引擎…", () => install(true));
    button(engine, "start", "启动并检查本地服务", async () => {
        try { await ManagedRuntime.ensureReady(); if (alive) showRuntime(await ManagedRuntime.readStatus()); }
        catch { if (alive) runtimeStatus.textContent = "本地服务未就绪，请先安装引擎或检查状态；未启动外部终端。"; }
    });
    button(engine, "refresh-status", "刷新状态", async () => {
        try { showRuntime(await ManagedRuntime.readStatus()); } catch { if (alive) runtimeStatus.textContent = "暂时无法读取引擎状态。"; }
    });
    const basic = section("03 / 翻译基本选项");
    const source = input(basic, "source", "源语言"); source.value = String(getPref("sourceLang") || "en");
    const target = input(basic, "target", "目标语言"); target.value = String(getPref("targetLang") || "zh-CN");
    const preset = select(basic, "preset", "并发 / QPS", [["keep", `保持当前设置（${getPref("poolSize") ?? 8} / ${getPref("qps") ?? 4}）`], ["conservative", "稳妥 · 8 并发 / 4 QPS"], ["fast", "高吞吐 · 128 并发 / 48 QPS"]]); preset.value = "keep";
    basic.appendChild(element("p", "高吞吐需服务商允许的限额与足够余额，可能触发限流。预设只在点击保存时应用，不改已有高级质量参数。"));
    const dual = select(basic, "dual", "双语布局", [["LR", "左右并排"], ["TB", "上下排列"]]); dual.value = String(getPref("dualMode") || "LR");
    const glossary = input(basic, "glossary", "关闭术语表自动提取", "checkbox"); glossary.checked = [true, "true", 1].includes(getPref("disableGlossary") as any);
    const basicStatus = status(basic, "basic-status");
    button(basic, "save-basic", "保存翻译选项", () => {
        try {
            const changes = translationPreferences({ preset: preset.value, sourceLang: source.value, targetLang: target.value, dualMode: dual.value, disableGlossary: glossary.checked });
            for (const [name, value] of Object.entries(changes)) setPref(name, value);
            preset.children[0].textContent = `保持当前设置（${getPref("poolSize")} / ${getPref("qps")}）`;
            preset.value = "keep";
            basicStatus.textContent = "翻译选项已保存，下次任务生效。";
        } catch { basicStatus.textContent = "请检查语言、双语布局和并发预设。"; }
    });
    const diagnostic = section("04 / 本机配置与脱敏诊断");
    diagnostic.appendChild(element("p", "原版高级编辑器在本页下方。诊断仅包含运行阶段、版本与并发，不包含密钥、API 地址或文档。"));
    const output = element("pre", "", "diagnostic"); diagnostic.appendChild(output);
    button(diagnostic, "diagnose", "生成脱敏诊断", () => {
        output.textContent = safeDiagnostics(currentStatus, { poolSize: getPref("poolSize"), qps: getPref("qps") });
    });
    const importStatus = status(diagnostic, "import-status");
    const importButton = button(diagnostic, "import", "从原版导入本机设置…", () => {
        if (!win.confirm("这会复制原版含 API 密钥的本地配置，不上传、不删除旧配置；服务地址将切为本插件的本地服务。已有新版 API 配置时拒绝覆盖。是否继续？")) return;
        try {
            const count = migrateLegacyPreferences(true);
            onSaved(); refresh();
            source.value = String(getPref("sourceLang") || "en"); target.value = String(getPref("targetLang") || "zh-CN");
            dual.value = String(getPref("dualMode") || "LR"); glossary.checked = [true, "true", 1].includes(getPref("disableGlossary") as any); preset.value = "keep";
            preset.children[0].textContent = `保持当前设置（${getPref("poolSize")} / ${getPref("qps")}）`;
            importStatus.textContent = `已导入 ${count} 项本机设置。旧配置未删除。`;
        } catch { importStatus.textContent = "未导入：已有新版 API 配置或旧配置不可读取。原配置未覆盖。"; }
    });
    importButton.hidden = !hasLegacyPreferences();
    refresh();
    const unsubscribe = ManagedRuntime.subscribe(showRuntime);
    void ManagedRuntime.readStatus().then(value => { if (alive) showRuntime(value); }).catch(() => {});
    const cleanup = () => {
        alive = false; unsubscribe();
        for (const remove of listeners) remove();
        win.removeEventListener("unload", cleanup);
    };
    win.addEventListener("unload", cleanup);
}
