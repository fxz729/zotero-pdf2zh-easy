import type { LLMApiData } from "./llmApiManager";

export interface EasyApiInput { apiUrl: string; apiKey: string; model: string; }

export function validateApiInput(input: EasyApiInput): EasyApiInput {
    let url: URL;
    try { url = new URL(input.apiUrl.trim()); } catch { throw new Error("请输入完整的 API Base URL。"); }
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname.toLowerCase());
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password || url.search || url.hash || /\s/.test(input.apiUrl.trim())) {
        throw new Error("API 地址须使用 HTTPS（回环地址可用 HTTP），且不能含用户名、密码或查询参数。");
    }
    const model = input.model.trim(), apiKey = input.apiKey.trim();
    if (!model || /[\r\n]/.test(model)) throw new Error("请填写模型名称。");
    if (!apiKey || /[\r\n]/.test(apiKey)) throw new Error("请填写有效的 API Key。");
    return { apiUrl: url.href.replace(/\/+$/, ""), apiKey, model };
}

export function readEasyApis(raw: unknown): LLMApiData[] {
    if (raw === undefined || raw === null || raw === "") return [];
    try {
        const entries = JSON.parse(String(raw));
        if (!Array.isArray(entries) || entries.some(entry => !entry || typeof entry !== "object" || typeof entry.key !== "string" || typeof entry.service !== "string")) throw new Error();
        return entries;
    } catch { throw new Error("API 配置格式无效，请在高级设置中检查；未覆盖原配置。"); }
}

export function saveEasyApi(raw: unknown, input: EasyApiInput, selectedKey: string, newKey: string): { profile: LLMApiData; serialized: string } {
    const entries = readEasyApis(raw);
    const existing = selectedKey ? entries.find(entry => entry.key === selectedKey) : undefined;
    if (selectedKey && !existing) throw new Error("此配置已被移除，请重新选择。");
    const values = validateApiInput({ ...input, apiKey: input.apiKey || existing?.apiKey || "" });
    const profile: LLMApiData = existing
        ? { ...existing, ...values, activate: true }
        : { key: newKey, service: "openailiked", ...values, activate: true, extraData: { openai_compatible_reasoning_effort: "none", openai_compatible_send_reasoning_effort: true } };
    const updated = entries.map(entry => entry.key === profile.key ? profile : entry.service === profile.service ? { ...entry, activate: false } : entry);
    if (!existing) updated.push(profile);
    return { profile, serialized: JSON.stringify(updated) };
}

export function translationPreferences(input: { preset: string; sourceLang: string; targetLang: string; dualMode: string; disableGlossary: boolean }): Record<string, string | number | boolean> {
    if (!["keep", "conservative", "fast"].includes(input.preset) || !["LR", "TB"].includes(input.dualMode) || !input.sourceLang.trim() || !input.targetLang.trim()) throw new Error("请检查翻译语言、双语布局和速度预设。");
    return {
        ...(input.preset === "keep" ? {} : input.preset === "fast" ? { poolSize: 128, qps: 48 } : { poolSize: 8, qps: 4 }),
        sourceLang: input.sourceLang.trim(), targetLang: input.targetLang.trim(), dualMode: input.dualMode, disableGlossary: input.disableGlossary,
    };
}

export function maskApiKey(value: string): string { return value ? "••••••••" : ""; }

export function runtimeLabel(status: { phase?: string }): string {
    const labels: Record<string, string> = {
        not_installed: "尚未安装", downloading: "正在下载安装组件", installing: "正在安装隔离引擎，请耐心等待", installed: "安装完成，翻译时自动启动", starting: "正在启动本地服务", ready: "本地服务已就绪", error: "引擎暂不可用，可检查网络后重试或修复", stopped: "本地服务未运行",
    };
    return Object.prototype.hasOwnProperty.call(labels, String(status.phase)) ? labels[String(status.phase)] : "状态待检查";
}

export function safeDiagnostics(status: { phase?: string; version?: string }, prefs: Record<string, unknown>): string {
    const version = /^\d[\w.\-]{0,30}$/.test(String(status.version)) ? status.version : "unknown";
    const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : "custom";
    return `PDF2zh Easy\n引擎：${runtimeLabel(status)}\n运行环境版本：${version}\n并发：${number(prefs.poolSize)}\nQPS：${number(prefs.qps)}\n不包含 API 密钥、地址、模型名称、文件路径或文档内容。`;
}
