/** Diagnostic copies only. Never apply this utility to engine requests or PDF bytes. */
const MASK = "[REDACTED]";
const secrets = new Set<string>();
const sensitive = /key|token|secret|password|auth|credential|cookie|headers?/i;
const labelled = /(["']?[\w-]*(?:key|token|secret|password|authorization|credential|cookie)[\w-]*["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;&}\]]+)/gi;

function registerSecret(value: string): void {
    if (!value) return;
    secrets.add(value);
    secrets.add(JSON.stringify(value).slice(1, -1));
    try { secrets.add(encodeURIComponent(value)); } catch { /* malformed Unicode still has its exact/JSON forms */ }
    const bearer = /^(?:Bearer|Basic)\s+(.+)$/i.exec(value);
    if (bearer) registerSecret(bearer[1]);
}

function register(value: unknown, hidden = false, seen = new WeakSet<object>()): void {
    if (value && typeof value === "object") {
        if (seen.has(value)) return;
        seen.add(value);
        if (Array.isArray(value)) value.forEach((item) => register(item, hidden, seen));
        else for (const key of Object.keys(value)) register((value as Record<string, unknown>)[key], hidden || sensitive.test(key), seen);
    } else if (typeof value === "string") {
        if (hidden) registerSecret(value);
        if (/^\s*[\[{]/.test(value)) {
            try { register(JSON.parse(value), hidden, seen); } catch { /* not serialized extraData */ }
        }
    }
}

function text(value: unknown): string {
    let result = value && typeof value === "object" && typeof (value as Error).message === "string"
        ? (value as Error).message : String(value ?? "");
    for (const secret of Array.from(secrets).sort((a, b) => b.length - a.length)) result = result.split(secret).join(MASK);
    return result
        .replace(/(https?:\/\/)[^/\s:@]+:[^/@\s]+@/gi, `$1${MASK}@`)
        .replace(/\b(Bearer|Basic)\s+[^\s,'";}\]]+/gi, `$1 ${MASK}`)
        .replace(labelled, (_match, prefix: string) => prefix + MASK);
}

function json(value: unknown, seen = new WeakSet<object>()): unknown {
    if (typeof value === "string") return text(value);
    if (!value || typeof value !== "object") return value;
    if (typeof (value as Error).message === "string" && value instanceof Error) return text(value);
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    if (Array.isArray(value)) return value.map((item) => json(item, seen));
    const copy: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(value)) copy[text(key)] = sensitive.test(key) || key.toLowerCase().replace(/[^a-z]/g, "") === "extradata"
        ? MASK : json((value as Record<string, unknown>)[key], seen);
    return copy;
}

export const Privacy = {
    register,
    text,
    json,
    log(...values: unknown[]): void {
        ztoolkit.log(...values.map((value) => json(value)));
    },
};
