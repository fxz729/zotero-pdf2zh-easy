import { runQuiet } from "./quietProcess";
import { getPref, setPref } from "../utils/prefs";
import { assertNoOriginalAddonConflict } from "./addonCompatibility";
import { RUNTIME_VERSION, PYTHON_VERSION, SERVICE_URL, platformAsset, safeRelativeAsset } from "./runtimeManifest";

export interface RuntimeStatus { phase: string; message: string; version: string; }

export class ManagedRuntime {
    private static installing: Promise<void> | null = null;
    private static preparing: Promise<boolean> | null = null;
    private static current: RuntimeStatus = { phase: "not_installed", message: "Install the translation engine in settings.", version: RUNTIME_VERSION };
    private static listeners = new Set<(status: RuntimeStatus) => void>();

    private static validDirectory(leaf: unknown): leaf is string {
        const prefix = `runtime-${RUNTIME_VERSION}-`;
        return typeof leaf === "string" && leaf.startsWith(prefix)
            && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(leaf.slice(prefix.length));
    }
    static get root(): string {
        const leaf = getPref("runtimeDirectory");
        if (leaf !== undefined && leaf !== null && leaf !== "" && !this.validDirectory(leaf)) throw new Error("Managed runtime directory is invalid.");
        return PathUtils.join(PathUtils.profileDir, "pdf2zh-easy", leaf ? String(leaf) : `runtime-${RUNTIME_VERSION}`);
    }
    static get python(): string { return this.pythonFor(this.root); }
    private static pythonFor(root: string): string {
        return PathUtils.join(root, "server", ".server-venv", Services.appinfo.OS === "WINNT" ? "Scripts" : "bin", Services.appinfo.OS === "WINNT" ? "python.exe" : "python");
    }
    private static helperFor(root: string): string { return PathUtils.join(root, "runtime", "bootstrap.py"); }

    static subscribe(listener: (status: RuntimeStatus) => void): () => void {
        this.listeners.add(listener);
        listener(this.current);
        return () => this.listeners.delete(listener);
    }
    private static state(phase: string, message: string): void {
        this.current = { phase, message, version: RUNTIME_VERSION };
        for (const listener of this.listeners) {
            try { listener(this.current); } catch { /* a closed settings window is not a runtime error */ }
        }
    }
    static async readStatus(): Promise<RuntimeStatus> {
        if (!this.installing) {
            try {
                const value = await IOUtils.readJSON(PathUtils.join(this.root, "status.json")) as RuntimeStatus;
                if (value && typeof value.phase === "string" && typeof value.message === "string") this.state(value.phase, value.message);
            } catch { /* first run has no status file */ }
        }
        return this.current;
    }
    static async isInstalled(root = this.root): Promise<boolean> {
        try {
            const marker = await IOUtils.readJSON(PathUtils.join(root, "installation.json")) as { version?: string; state?: string; python?: string };
            const engine = PathUtils.join(root, "server", "zotero-pdf2zh-next-venv", Services.appinfo.OS === "WINNT" ? "Scripts" : "bin", Services.appinfo.OS === "WINNT" ? "python.exe" : "python");
            return !!marker && typeof marker === "object" && !Array.isArray(marker)
                && marker.version === RUNTIME_VERSION && (marker.state === undefined || marker.state === "ready")
                && (marker.python === undefined || marker.python === PYTHON_VERSION)
                && await IOUtils.exists(this.pythonFor(root)) && await IOUtils.exists(engine);
        } catch { return false; }
    }
    static async startIfInstalled(): Promise<boolean> {
        if (!await this.isInstalled()) return false;
        return this.ensureReady();
    }
    static ensureReady(serverUrl = SERVICE_URL): Promise<boolean> {
        if (!/^http:\/\/(127\.0\.0\.1|localhost):8891\/?$/i.test(serverUrl)) return Promise.resolve(false);
        if (!this.preparing) {
            this.preparing = (async () => {
                if (this.installing) await this.installing;
                const root = this.root;
                if (!await this.isInstalled(root)) throw new Error("Translation engine is not installed. Open PDF2zh Easy settings to install it.");
                await assertNoOriginalAddonConflict();
                this.state("starting", "Preparing the local translation service…");
                const result = await runQuiet(this.pythonFor(root), ["-X", "utf8", "-u", this.helperFor(root), "ensure"], 50000, this.environment(root));
                if (result !== 0) throw new Error("Local translation service could not be verified or started. Open settings for status.");
                this.state("ready", "Local translation service is ready.");
                return true;
            })().catch(error => {
                this.state("error", "Local translation service is unavailable. Check settings and retry.");
                throw error;
            }).finally(() => { this.preparing = null; });
        }
        return this.preparing;
    }
    private static environment(root = this.root): Record<string, string | null> {
        const rawProxy = Services.env.get("NO_PROXY") || Services.env.get("no_proxy") || "localhost,127.0.0.1,::1";
        const proxy = rawProxy.split(",").map(value => value.trim()).filter(value => value && value !== "[::1]").join(",");
        return { UV_PYTHON_INSTALL_DIR: PathUtils.join(root, "python"), UV_CACHE_DIR: PathUtils.join(root, "cache"),
            PYTHONUTF8: "1", PYTHONUNBUFFERED: "1", PYTHONNOUSERSITE: "1", UV_NO_PROGRESS: "1",
            PYTHONPATH: null, PYTHONHOME: null, VIRTUAL_ENV: null, CONDA_PREFIX: null, NO_PROXY: proxy, no_proxy: proxy };
    }
    private static async token(): Promise<string> {
        const value = (await IOUtils.readUTF8(PathUtils.join(this.root, "service-token"))).trim();
        if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("Local service identity is invalid. Repair the installation in settings.");
        return value;
    }
    static async request(method: string, url: string, options: any = {}): Promise<XMLHttpRequest> {
        const headers = { ...options.headers };
        if (url.startsWith(SERVICE_URL + "/")) headers["X-PDF2zh-Easy-Token"] = await this.token();
        return Zotero.HTTP.request(method, url, { ...options, headers, followRedirects: false, errorDelayMax: 0, debug: false, logBodyLength: 0 });
    }
    static async fetch(url: string, options: RequestInit = {}, timeoutMs = 30000): Promise<Response> {
        const headers = new Headers(options.headers);
        if (url.startsWith(SERVICE_URL + "/")) headers.set("X-PDF2zh-Easy-Token", await this.token());
        let controller: AbortController;
        try {
            // The addon loadSubScript global has fetch, but no AbortController.
            const Abort = (Zotero.getMainWindow() as (Window & { AbortController?: typeof AbortController }) | null)?.AbortController;
            if (typeof Abort !== "function") throw new Error();
            controller = new Abort();
            if (!controller.signal || typeof controller.abort !== "function") throw new Error();
        } catch { throw new Error("Secure request cancellation is unavailable."); }
        const cancel = () => controller.abort();
        if (options.signal?.aborted) controller.abort();
        options.signal?.addEventListener("abort", cancel, { once: true });
        let timer: ReturnType<typeof setTimeout> | undefined;
        const work = (async () => {
            const response = await fetch(url, { ...options, headers, signal: controller.signal, redirect: "error", credentials: "omit", cache: "no-store" });
            // Keep the deadline active while reading the body, not just headers.
            const chunks: Uint8Array[] = [];
            let length = 0;
            const reader = response.body?.getReader();
            if (reader) {
                while (true) {
                    const value = await reader.read();
                    if (value.done) break;
                    length += value.value.byteLength;
                    if (length > 256 * 1024 * 1024) { controller.abort(); throw new Error("Translation response exceeds the safe download limit."); }
                    chunks.push(value.value);
                }
            }
            const body = new Uint8Array(length);
            let offset = 0;
            for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
            return new Response(length ? body : null, { status: response.status, statusText: response.statusText, headers: response.headers });
        })();
        const deadline = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => { controller.abort(); reject(new Error("Translation service request timed out.")); }, timeoutMs);
        });
        try { return await Promise.race([work, deadline]); }
        finally {
            if (timer !== undefined) clearTimeout(timer);
            options.signal?.removeEventListener("abort", cancel);
        }
    }
    private static async sha256(bytes: Uint8Array): Promise<string> {
        const crypto = Zotero.getMainWindow()?.crypto;
        if (!crypto?.subtle) throw new Error("Secure checksum verification is unavailable.");
        const digest = await crypto.subtle.digest("SHA-256", bytes);
        return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
    }
    private static async bundledBytes(uri: string, maximum: number): Promise<Uint8Array> {
        // Zotero.File's text URL reader routes jar:file through HTTP._parseURI.
        // Native channels handle packaged URIs and preserve BOM/CRLF/source bytes.
        const failed = () => new Error("Bundled runtime asset could not be read safely.");
        if (!/^(?:jar:file:|file:|chrome:|resource:)/.test(uri)
            || !Number.isSafeInteger(maximum) || maximum < 0 || maximum > 1024 * 1024) throw failed();
        return new Promise<Uint8Array>((resolve, reject) => {
            try {
                const { NetUtil } = ChromeUtils.importESModule("resource://gre/modules/NetUtil.sys.mjs");
                const channel = NetUtil.newChannel({ uri, loadUsingSystemPrincipal: true });
                NetUtil.asyncFetch(channel, (stream: nsIInputStream, status: number) => {
                    let binary: nsIBinaryInputStream | undefined;
                    let attached = false;
                    try {
                        if (!Components.isSuccessCode(status)) throw failed();
                        const length = stream.available();
                        if (!Number.isSafeInteger(length) || length < 0 || length > maximum) throw failed();
                        binary = (Components.classes as any)["@mozilla.org/binaryinputstream;1"].createInstance(Components.interfaces.nsIBinaryInputStream);
                        binary!.setInputStream(stream);
                        attached = true;
                        const bytes = length ? new Uint8Array(binary!.readByteArray(length)) : new Uint8Array();
                        if (bytes.byteLength !== length) throw failed();
                        let remaining = 0;
                        try { remaining = stream.available(); }
                        catch (error) {
                            // Native jar streams may close themselves at exact EOF.
                            // Only this result is equivalent to zero, after a full read.
                            const closed = Components.results.NS_BASE_STREAM_CLOSED;
                            if (typeof closed !== "number" || (error as { result?: unknown } | null)?.result !== closed) throw failed();
                        }
                        if (remaining !== 0) throw failed();
                        resolve(bytes);
                    } catch {
                        reject(failed());
                    } finally {
                        try { if (attached) binary!.close(); else stream?.close(); }
                        catch { try { stream?.close(); } catch { /* best-effort native cleanup */ } }
                    }
                });
            } catch {
                reject(failed());
            }
        });
    }
    static async stageAssets(root = this.root): Promise<void> {
        const base = rootURI + "content/runtime/";
        let manifest: any;
        try {
            const bytes = await this.bundledBytes(base + "runtime-manifest.json", 64 * 1024);
            manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        } catch { throw new Error("Invalid bundled runtime manifest."); }
        if (manifest?.version !== RUNTIME_VERSION || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 100) throw new Error("Invalid bundled runtime manifest.");
        const names = new Set<string>();
        let total = 0;
        // Verify all public sources before writing any of them.
        const pending: Array<{ path: string; bytes: Uint8Array }> = [];
        for (const entry of manifest.files) {
            const relative = safeRelativeAsset(entry.path);
            if (names.has(relative) || !/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isInteger(entry.size) || entry.size < 0 || entry.size > 1024 * 1024) throw new Error("Invalid bundled runtime asset.");
            names.add(relative);
            const bytes = await this.bundledBytes(base + relative, entry.size);
            total += bytes.byteLength;
            if (total > 8 * 1024 * 1024 || bytes.byteLength !== entry.size || await this.sha256(bytes) !== entry.sha256) throw new Error("Bundled source checksum mismatch.");
            pending.push({ path: PathUtils.join(root, ...relative.split("/")), bytes });
        }
        for (const entry of pending) {
            await IOUtils.makeDirectory(PathUtils.parent(entry.path)!, { ignoreExisting: true, createAncestors: true });
            await IOUtils.write(entry.path, entry.bytes);
        }
    }
    static async downloadUv(root = this.root): Promise<string> {
        const asset = platformAsset(Services.appinfo.OS, Services.appinfo.XPCOMABI);
        const binary = PathUtils.join(root, "bin", asset.executable);
        const infoPath = PathUtils.join(root, "uv-info.json");
        try {
            const previous = await IOUtils.readJSON(infoPath) as any;
            if (previous?.archiveSha256 === asset.sha256 && await this.sha256(await IOUtils.read(binary)) === previous.binarySha256) return binary;
        } catch { /* initial or damaged verified download */ }
        this.state("downloading", "Downloading verified uv runtime manager…");
        const response = await Zotero.HTTP.request("GET", asset.url, {
            responseType: "arraybuffer", timeout: 180000, errorDelayMax: 0, debug: false, logBodyLength: 0,
            requestObserver: (xhr: XMLHttpRequest) => {
                xhr.addEventListener("progress", event => {
                    if (event.loaded > 64 * 1024 * 1024) xhr.abort();
                    else if (event.lengthComputable) this.state("downloading", `Downloading runtime manager… ${Math.round(event.loaded / event.total * 100)}%`);
                });
            },
        });
        const bytes = new Uint8Array(response.response);
        if (bytes.byteLength > 64 * 1024 * 1024 || await this.sha256(bytes) !== asset.sha256) throw new Error("Runtime download checksum mismatch. Nothing was executed.");
        const crypto = Zotero.getMainWindow()!.crypto;
        const staging = PathUtils.join(root, "downloads", "uv-" + crypto.randomUUID());
        await IOUtils.makeDirectory(staging, { createAncestors: true, ignoreExisting: true });
        const archive = PathUtils.join(staging, asset.format === "zip" ? "uv.zip" : "uv.tar.gz");
        const extracted = PathUtils.join(staging, asset.executable);
        await IOUtils.write(archive, bytes);
        if (asset.format === "zip") {
            // Registered by Gecko, but absent from the pinned class-id typings.
            const reader: nsIZipReader = (Components.classes as any)["@mozilla.org/libjar/zip-reader;1"].createInstance(Components.interfaces.nsIZipReader);
            try {
                reader.open(Zotero.File.pathToFile(archive));
                const entry = reader.getEntry(asset.archiveEntry);
                if (entry.isDirectory || entry.realSize > 128 * 1024 * 1024) throw new Error("Invalid runtime archive entry.");
                reader.extract(asset.archiveEntry, Zotero.File.pathToFile(extracted));
            } finally { reader.close(); }
        } else {
            // The hash is pinned; extract just the known binary, not arbitrary entries.
            const result = await runQuiet("/usr/bin/tar", ["-xzf", archive, "-C", staging, "--strip-components=1", asset.archiveEntry], 30000);
            if (result !== 0) throw new Error("Runtime archive could not be extracted.");
        }
        if (Zotero.File.pathToFile(extracted).isSymlink()) throw new Error("Linked runtime executables are not allowed.");
        await IOUtils.makeDirectory(PathUtils.parent(binary)!, { createAncestors: true, ignoreExisting: true });
        await IOUtils.move(extracted, binary, { noOverwrite: false });
        if (Services.appinfo.OS !== "WINNT") await IOUtils.setPermissions(binary, 0o700);
        const binarySha256 = await this.sha256(await IOUtils.read(binary));
        await IOUtils.writeUTF8(infoPath, JSON.stringify({ archiveSha256: asset.sha256, binarySha256 }));
        return binary;
    }
    private static async assertIdle(root: string): Promise<void> {
        const python = this.pythonFor(root), helper = this.helperFor(root);
        const hasPython = await IOUtils.exists(python), hasHelper = await IOUtils.exists(helper);
        if (!hasPython || !hasHelper) {
            // A pristine first install has nothing to probe. An incomplete tree
            // with service evidence must not be treated as proof of idleness.
            if (hasPython || hasHelper || await IOUtils.exists(PathUtils.join(root, "service.lock"))
                || await IOUtils.exists(PathUtils.join(root, "server-pid.json"))
                || await IOUtils.exists(PathUtils.join(root, "service-token"))) {
                throw new Error("The incomplete managed runtime could not be verified as idle.");
            }
            return;
        }
        // The bootstrap probe is observational: 0 includes a running/pending
        // service or occupied lifetime lock, 3 is confirmed idle, all else fails.
        const probe = await runQuiet(python, ["-X", "utf8", "-u", helper, "probe"], 5000, this.environment(root));
        if (probe === 0) throw new Error("The managed service is running or busy. Wait for translation tasks to finish before installing.");
        if (probe !== 3) throw new Error("The managed service could not be verified as idle. Installation was not activated.");
    }

    static install(consent: boolean, repair = false): Promise<void> {
        if (!consent) return Promise.reject(new Error("Explicit first-run download consent is required."));
        if (!this.installing) {
            // Capture before publishing installing: an already running ensure
            // must finish independently, while later ensures wait for us.
            const preparing = this.preparing;
            this.installing = (async () => {
                const activeRoot = this.root;
                if (preparing) await preparing.catch(() => {});
                if (await this.isInstalled(activeRoot) && !repair) return;
                await this.assertIdle(activeRoot);
                const leaf = `runtime-${RUNTIME_VERSION}-${Zotero.getMainWindow()?.crypto.randomUUID()}`;
                if (!this.validDirectory(leaf)) throw new Error("Secure candidate runtime directory creation is unavailable.");
                const candidate = PathUtils.join(PathUtils.profileDir, "pdf2zh-easy", leaf);
                this.state("installing", "Preparing a new isolated runtime candidate…");
                await IOUtils.makeDirectory(candidate, { createAncestors: true, ignoreExisting: false });
                if (Services.appinfo.OS !== "WINNT") await IOUtils.setPermissions(candidate, 0o700);
                await this.stageAssets(candidate);
                const uv = await this.downloadUv(candidate);
                this.state("installing", "Preparing isolated Python. The first download may take several minutes…");
                const prepared = await runQuiet(uv, ["venv", PathUtils.join(candidate, "server", ".server-venv"), "--allow-existing", "--python", PYTHON_VERSION, "--managed-python"], 600000, this.environment(candidate));
                if (prepared !== 0) throw new Error("Isolated Python setup failed. Retry in settings.");
                const installed = await runQuiet(this.pythonFor(candidate), ["-X", "utf8", "-u", this.helperFor(candidate), "install"], 1800000, this.environment(candidate));
                if (installed !== 0 || !await this.isInstalled(candidate)) throw new Error("Translation engine candidate installation failed. Open settings to retry.");
                await this.assertIdle(activeRoot);
                await this.assertIdle(candidate);
                if (this.root !== activeRoot) throw new Error("The active runtime directory changed during installation. The candidate was not activated.");
                // Commit one constrained relative leaf only after all validation.
                // No active source, binary, environment, or identity was changed.
                setPref("runtimeDirectory", leaf);
                this.state("installed", "Translation engine installed. It will start automatically when needed.");
            })().catch(error => {
                this.state("error", "Engine installation failed. The previous runtime was not changed. Check settings and retry.");
                throw error;
            }).finally(() => { this.installing = null; });
        }
        return this.installing;
    }
}
