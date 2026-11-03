import { config } from "../../package.json";
import { SERVICE_URL } from "./runtimeManifest";

const LEGACY = "extensions.zotero.pdf2zh.";
const destination = () => config.prefsPrefix + ".";

function legacyKeys(): string[] {
    return Services.prefs.getChildList(LEGACY).filter(key => key.startsWith(LEGACY) && Services.prefs.prefHasUserValue(key));
}

export function hasLegacyPreferences(): boolean {
    return legacyKeys().length > 0;
}

export function migrateLegacyPreferences(consent: boolean): number {
    if (!consent) throw new Error("Explicit local preference migration consent is required.");
    const fresh = destination();
    if (fresh === LEGACY) throw new Error("The independent preference namespace is not configured.");
    const existing = Zotero.Prefs.get(fresh + "llmApis", true);
    if (existing) {
        try {
            const parsed = JSON.parse(String(existing));
            if (!Array.isArray(parsed) || parsed.length) throw new Error();
        } catch {
            throw new Error("Existing Easy API profiles will not be overwritten.");
        }
    }
    if (Zotero.Prefs.get(fresh + "legacyMigrationComplete", true)) throw new Error("Existing legacy migration has already completed.");
    const keys = legacyKeys();
    if (!keys.length) return 0;
    const changes = new Map<string, string | number | boolean>();
    for (const key of keys) {
        const value = Zotero.Prefs.get(key, true);
        if (typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isInteger(value)) {
            changes.set(fresh + key.slice(LEGACY.length), value);
        }
    }
    // Keep all API/quality choices; only the managed service address changes.
    changes.set(fresh + "new_serverip", SERVICE_URL);
    changes.set(fresh + "legacyMigrationComplete", true);
    const previous = Array.from(changes.keys(), key => ({ key, existed: Services.prefs.prefHasUserValue(key), value: Zotero.Prefs.get(key, true) }));
    try {
        for (const [key, value] of changes) Zotero.Prefs.set(key, value, true);
    } catch {
        for (const entry of previous) {
            try {
                if (entry.existed) Zotero.Prefs.set(entry.key, entry.value as string | number | boolean, true);
                else Zotero.Prefs.clear(entry.key, true);
            } catch { /* keep the original, generic migration error */ }
        }
        throw new Error("Local preference migration could not be saved. The original configuration was not changed.");
    }
    // Never log values: this list may include a user's provider credentials.
    return changes.size - 1;
}
