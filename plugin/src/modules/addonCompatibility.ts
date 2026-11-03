// Independent identity avoids update/chrome collisions; this guard avoids two
// addons translating the same selection. Never change another addon's state.
export async function assertNoOriginalAddonConflict(): Promise<void> {
    let original: any;
    try {
        const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
        original = await AddonManager.getAddonByID("pdf2zh@guaguastandup.com");
    } catch {
        throw new Error("Addon compatibility could not be verified.");
    }
    if (original?.isActive) {
        throw new Error("Disable the original Zotero PDF2zh addon before using PDF2zh Easy. Its saved configuration will be kept.");
    }
}
