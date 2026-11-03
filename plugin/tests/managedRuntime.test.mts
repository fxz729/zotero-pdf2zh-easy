import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { webcrypto } from "node:crypto";
import ts from "typescript";

function setup(conflict = false) {
    const files = new Map<string, any>();
    const calls: any[] = [];
    const requests: any[] = [];
    const prefs = new Map<string, any>();
    const writes: string[] = [];
    const pointerWrites: any[] = [];
    let quiet: ((...args: any[]) => Promise<number>) | undefined;
    const assets = new Map<string, string | Uint8Array>();
    const legacyReads: string[] = [];
    const channels: any[] = [];
    const streams: any[] = [];
    const statusChecks: number[] = [];
    const native = { status: 0, readError: false, availableError: false, shortRead: false,
        createError: false, attachError: false, reportedSizes: new Map<string, number>(),
        preException: undefined as unknown, postException: undefined as unknown, postRemaining: undefined as number | undefined };
    const root = "/profile/pdf2zh-easy/runtime-0.1.0";
    const encoder = new TextEncoder();
    const io = {
        exists: async (file: string) => files.has(file),
        readJSON: async (file: string) => { if (!files.has(file)) throw new Error("missing"); return JSON.parse(files.get(file)); },
        readUTF8: async (file: string) => { if (!files.has(file)) throw new Error("missing"); return files.get(file); },
        read: async (file: string) => files.get(file),
        write: async (file: string, value: Uint8Array) => { writes.push(file); files.set(file, value); },
        writeUTF8: async (file: string, value: string) => { writes.push(file); files.set(file, value); },
        makeDirectory: async (file: string) => { writes.push(file); }, setPermissions: async (file: string) => { writes.push(file); },
        move: async (from: string, to: string) => { writes.push(to); files.set(to, files.get(from)); files.delete(from); },
    };
    const manifest = { RUNTIME_VERSION: "0.1.0", PYTHON_VERSION: "3.12.13", SERVICE_URL: "http://127.0.0.1:8891",
        safeRelativeAsset: (name: string) => { if (name.includes("..") || name.startsWith("/")) throw new Error("Invalid runtime asset path."); return name; },
        platformAsset: () => ({ url: "https://github.com/astral-sh/uv/releases/download/0.13.6/uv-test.tar.gz", sha256: "a".repeat(64), executable: "uv", archiveEntry: "uv-test/uv", format: "tar.gz" }),
    };
    const NetUtil = {
        newChannel(options: any) { channels.push(options); return { ...options }; },
        asyncFetch(channel: any, callback: (stream: any, status: number) => void) {
            const asset = assets.get(channel.uri);
            const bytes = typeof asset === "string" ? encoder.encode(asset) : asset || new Uint8Array();
            let offset = 0;
            const stream = {
                uri: channel.uri, closes: 0, reads: 0, availabilityChecks: 0,
                available() {
                    stream.availabilityChecks++;
                    if (stream.availabilityChecks === 1 && native.preException !== undefined) throw native.preException;
                    if (stream.availabilityChecks > 1) {
                        if (native.postException !== undefined) throw native.postException;
                        if (native.postRemaining !== undefined) return native.postRemaining;
                    }
                    if (native.availableError) throw new Error("synthetic-private-stream-metadata");
                    return native.reportedSizes.get(channel.uri) ?? bytes.length - offset;
                },
                read(count: number) {
                    stream.reads++;
                    if (native.readError) throw new Error("synthetic-private-stream-read");
                    const actual = native.shortRead ? Math.max(0, count - 1) : count;
                    const result = Array.from(bytes.slice(offset, offset + actual));
                    offset += actual;
                    return result;
                },
                close() { stream.closes++; },
            };
            streams.push(stream);
            callback(stream, assets.has(channel.uri) ? native.status : 0x80004005);
        },
    };
    const components = {
        results: { NS_BASE_STREAM_CLOSED: 0x80470002 },
        isSuccessCode(status: number) { statusChecks.push(status); return (status & 0x80000000) === 0; },
        interfaces: { nsIBinaryInputStream: {} },
        classes: { "@mozilla.org/binaryinputstream;1": { createInstance() {
            if (native.createError) throw new Error("synthetic-private-binary-instance");
            let input: any;
            return {
                setInputStream(stream: any) {
                    if (native.attachError) throw new Error("synthetic-private-binary-attach");
                    input = stream;
                },
                readByteArray(count: number) { return input.read(count); },
                close() { input.close(); },
            };
        } } },
    };
    const context: any = vm.createContext({
        TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, JSON, setTimeout, clearTimeout, Headers, AbortController, Response,
        ChromeUtils: { importESModule(uri: string) { assert.equal(uri, "resource://gre/modules/NetUtil.sys.mjs"); return { NetUtil }; } },
        Components: components,
        fetch: async (url: string, opts: any) => { requests.push({ method: opts.method || "GET", url, opts }); return new Response("{}", { status: 200 }); },
        rootURI: "resource://test/", IOUtils: io,
        PathUtils: { profileDir: "/profile", join: (...values: string[]) => path.posix.join(...values), parent: path.posix.dirname },
        Services: { appinfo: { OS: "Linux", XPCOMABI: "x86_64-gcc3" }, env: { get: () => "" } },
        Zotero: {
            getMainWindow: () => ({ crypto: webcrypto, AbortController }),
            File: { getContentsFromURLAsync: async (url: string) => {
                legacyReads.push(url);
                if (!assets.has(url)) throw new Error("missing asset");
                const value = assets.get(url);
                return typeof value === "string" ? value : new TextDecoder().decode(value);
            }, pathToFile: () => ({ isSymlink: () => false }) },
            HTTP: { request: async (method: string, url: string, opts: any) => { requests.push({ method, url, opts }); return { response: new ArrayBuffer(8), responseText: '{"tasks":[]}' }; } },
        },
    });
    const source = fs.readFileSync(new URL("../src/modules/managedRuntime.ts", import.meta.url), "utf8");
    const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const exports: any = {};
    vm.runInContext(`(function(require,exports){${js}\n})`, context)((name: string) => {
        if (name === "./runtimeManifest") return manifest;
        if (name === "./addonCompatibility") return { assertNoOriginalAddonConflict: async () => { if (conflict) throw new Error("Disable the original Zotero PDF2zh addon."); } };
        if (name === "./quietProcess") return { runQuiet: async (...args: any[]) => { calls.push(args); return quiet ? quiet(...args) : 0; } };
        if (name === "../utils/prefs") return { getPref: (key: string) => prefs.get(key), setPref: (key: string, value: any) => { pointerWrites.push([key, value]); prefs.set(key, value); } };
        return {};
    }, exports);
    function installed() {
        files.set(root + "/installation.json", JSON.stringify({ version: "0.1.0" }));
        files.set(root + "/server/.server-venv/bin/python", "executable");
        files.set(root + "/runtime/bootstrap.py", "helper");
        files.set(root + "/server/zotero-pdf2zh-next-venv/bin/python", "executable");
        files.set(root + "/service-token", "a".repeat(64));
    }
    return { Runtime: exports.ManagedRuntime, root, files, calls, requests, assets, installed, encoder, prefs, writes, pointerWrites, context, io, manifest,
        native, channels, streams, statusChecks, legacyReads,
        setQuiet: (fn: (...args: any[]) => Promise<number>) => quiet = fn };
}

async function bundledFixture(s: ReturnType<typeof setup>, bytes = s.encoder.encode("synthetic public source\r\n"), manifestBOM = false) {
    const base = s.context.rootURI + "content/runtime/";
    const digest = Buffer.from(await webcrypto.subtle.digest("SHA-256", bytes)).toString("hex");
    const manifest = s.encoder.encode(JSON.stringify({ version: "0.1.0", files: [{ path: "runtime/bootstrap.py", size: bytes.byteLength, sha256: digest }] }));
    s.assets.set(base + "runtime-manifest.json", manifestBOM ? new Uint8Array([0xef, 0xbb, 0xbf, ...manifest]) : manifest);
    s.assets.set(base + "runtime/bootstrap.py", bytes);
    return base;
}

test("ordinary startup never downloads or installs without first-run consent", async () => {
    const s = setup();
    assert.equal(await s.Runtime.startIfInstalled(), false);
    await assert.rejects(s.Runtime.install(false), /consent/i);
    assert.equal(s.calls.length, 0);
    assert.equal(s.requests.length, 0);
});

test("translation readiness is shared and never runs an uninstalled engine", async () => {
    const s = setup();
    await assert.rejects(s.Runtime.ensureReady(), /not installed/i);
    assert.equal(s.calls.length, 0);
    s.installed();
    await Promise.all([s.Runtime.ensureReady(), s.Runtime.ensureReady()]);
    assert.equal(s.calls.length, 1);
    assert.ok(s.calls[0][0].startsWith(s.root));
    assert.equal(s.calls[0][1].at(-1), "ensure");
});

test("an active original addon prevents launching the independent service", async () => {
    const s = setup(true); s.installed();
    await assert.rejects(s.Runtime.ensureReady(), /Disable the original/);
    assert.equal(s.calls.length, 0);
});

test("repair refuses a running verified service before copying assets or changing environments", async () => {
    const s = setup(); s.installed();
    await assert.rejects(s.Runtime.install(true, true), /service.*running/i);
    assert.equal(s.calls.length, 1);
    assert.equal(s.calls[0][1].at(-1), "probe");
    assert.equal(s.requests.length, 0);
});

test("only canonical local requests carry the session token and may not redirect or log body", async () => {
    const s = setup(); s.installed();
    await s.Runtime.request("POST", "http://127.0.0.1:8891/translate", { body: "private-body", headers: { "Content-Type": "application/json" } });
    const local = s.requests[0].opts;
    assert.equal(local.headers["X-PDF2zh-Easy-Token"], "a".repeat(64));
    assert.equal(local.headers["Content-Type"], "application/json");
    assert.equal(local.followRedirects, false);
    assert.equal(local.errorDelayMax, 0);
    assert.equal(local.logBodyLength, 0);
    await s.Runtime.request("GET", "https://remote.example/api/tasks", {});
    assert.equal(s.requests[1].opts.headers?.["X-PDF2zh-Easy-Token"], undefined);
});

test("fetch submission and downloads use session authentication, no redirects, and bounded IO", async () => {
    const s = setup(); s.installed();
    await s.Runtime.fetch("http://127.0.0.1:8891/translate", { method: "POST", body: "private-body", headers: { "Content-Type": "application/json" } });
    const options = s.requests[0].opts;
    assert.equal(options.headers.get("X-PDF2zh-Easy-Token"), "a".repeat(64));
    assert.equal(options.headers.get("Content-Type"), "application/json");
    assert.equal(options.redirect, "error");
    assert.equal(options.credentials, "omit");
    assert.ok(options.signal);
});

test("fetch uses the real main-window AbortController when the addon global has none", async () => {
    const s = setup(); s.installed(); delete s.context.AbortController;
    let constructed = 0;
    class WindowAbortController extends AbortController {
        constructor() { super(); constructed++; }
    }
    s.context.Zotero.getMainWindow = () => ({ crypto: webcrypto, AbortController: WindowAbortController });
    const response = await s.Runtime.fetch("http://127.0.0.1:8891/api/tasks");
    assert.equal(response.status, 200);
    assert.equal(constructed, 1);
    assert.ok(s.requests[0].opts.signal instanceof AbortSignal);
});

test("fetch never selects an unrelated ambient AbortController over the window constructor", async () => {
    const s = setup(); s.installed();
    s.context.AbortController = class { constructor() { throw new Error("synthetic ambient constructor must not run"); } };
    const response = await s.Runtime.fetch("http://127.0.0.1:8891/api/tasks");
    assert.equal(response.status, 200);
    assert.ok(s.requests[0].opts.signal instanceof AbortSignal);
});

test("fetch fails closed before requesting when the real window has no usable abort constructor", async () => {
    for (const constructor of [undefined, null, {}, () => {}, function () {}, function () { throw new Error("synthetic-private-window-constructor"); }]) {
        const s = setup(); s.installed();
        s.context.Zotero.getMainWindow = () => ({ crypto: webcrypto, AbortController: constructor });
        await assert.rejects(s.Runtime.fetch("http://127.0.0.1:8891/api/tasks"), (error: Error) => {
            assert.match(error.message, /cancellation|abort|unavailable/i);
            assert.doesNotMatch(error.message, /synthetic-private/);
            return true;
        });
        assert.equal(s.requests.length, 0);
    }
    const s = setup(); s.installed(); s.context.Zotero.getMainWindow = () => null;
    await assert.rejects(s.Runtime.fetch("http://127.0.0.1:8891/api/tasks"), /cancellation|abort|unavailable/i);
    assert.equal(s.requests.length, 0);
});

test("fetch accepts native Headers and tuple headers while keeping remote requests unauthenticated", async () => {
    const s = setup(); s.installed();
    for (const headers of [new Headers({ "Content-Type": "application/json" }), [["Content-Type", "application/json"]] as [string, string][]]) {
        const response = await s.Runtime.fetch("https://remote.example/api/tasks", { headers });
        assert.equal(response.status, 200); assert.deepEqual(await response.json(), {});
        assert.equal(s.requests.at(-1).opts.headers.get("Content-Type"), "application/json");
        assert.equal(s.requests.at(-1).opts.headers.get("X-PDF2zh-Easy-Token"), null);
    }
});

test("fetch deadline remains active after headers when the response body stalls", async () => {
    const s = setup(); s.installed(); delete s.context.AbortController; let signal: AbortSignal;
    s.context.fetch = async (_url: string, options: any) => {
        signal = options.signal;
        return { status: 200, statusText: "OK", headers: new Headers(), body: { getReader: () => ({ read: () => new Promise(() => {}) }) } };
    };
    await assert.rejects(s.Runtime.fetch("http://127.0.0.1:8891/api/tasks", {}, 10), /timed out/);
    assert.equal(signal!.aborted, true);
});

test("caller cancellation aborts response body reading without waiting for the deadline", async () => {
    const s = setup(); s.installed(); delete s.context.AbortController;
    const controller = new AbortController();
    let reading!: () => void; const started = new Promise<void>(resolve => { reading = resolve; });
    s.context.fetch = async (_url: string, options: any) => ({ status: 200, statusText: "OK", headers: new Headers(), body: { getReader: () => ({ read: () => new Promise((_resolve, reject) => { options.signal.addEventListener("abort", () => reject(new Error("synthetic aborted body")), { once: true }); reading(); }) }) } });
    const request = s.Runtime.fetch("http://127.0.0.1:8891/api/tasks", { signal: controller.signal });
    await started; controller.abort();
    await assert.rejects(request, /aborted body/);
});

test("oversized response bodies abort before concatenation without allocating a giant test buffer", async () => {
    const s = setup(); s.installed(); let signal: AbortSignal;
    s.context.fetch = async (_url: string, options: any) => {
        signal = options.signal;
        return { status: 200, statusText: "OK", headers: new Headers(), body: { getReader: () => ({ read: async () => ({ done: false, value: { byteLength: 256 * 1024 * 1024 + 1 } }) }) } };
    };
    await assert.rejects(s.Runtime.fetch("http://127.0.0.1:8891/translatedFile/test.pdf"), /safe download limit/);
    assert.equal(signal!.aborted, true);
});

test("corrupt identity prevents sending documents rather than resetting the token", async () => {
    const s = setup(); s.installed();
    s.files.set(s.root + "/service-token", "broken");
    await assert.rejects(s.Runtime.request("POST", "http://127.0.0.1:8891/translate", { body: "private" }), /identity/i);
    assert.equal(s.requests.length, 0);
});

test("native system-principal channels preserve raw source bytes for jar, chrome, file and resource roots", async () => {
    for (const rootURI of ["jar:file:///synthetic/addon.xpi!/", "chrome://synthetic/content/", "file:///synthetic/addon/", "resource://synthetic/"]) {
        const s = setup();
        s.context.rootURI = rootURI;
        const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...s.encoder.encode("公开源代码\r\n"), 0, 0xff]);
        const base = await bundledFixture(s, bytes, true);
        await s.Runtime.stageAssets();
        assert.deepEqual(s.files.get(s.root + "/runtime/bootstrap.py"), bytes);
        assert.deepEqual(s.channels.map(channel => channel.uri), [base + "runtime-manifest.json", base + "runtime/bootstrap.py"]);
        assert.ok(s.channels.every(channel => channel.loadUsingSystemPrincipal === true));
        assert.equal(s.legacyReads.length, 0);
        assert.equal(s.requests.length, 0);
        assert.ok(s.streams.every(stream => stream.closes === 1));
    }
});

test("empty raw sources are verified and written without text conversion", async () => {
    const s = setup(); await bundledFixture(s, new Uint8Array());
    await s.Runtime.stageAssets();
    assert.deepEqual(s.files.get(s.root + "/runtime/bootstrap.py"), new Uint8Array());
    assert.ok(s.streams.every(stream => stream.closes === 1));
});

test("asynchronous native callbacks are awaited before candidate writes", async () => {
    const s = setup(); await bundledFixture(s);
    const { NetUtil } = s.context.ChromeUtils.importESModule("resource://gre/modules/NetUtil.sys.mjs");
    const fetch = NetUtil.asyncFetch;
    NetUtil.asyncFetch = (channel: any, callback: any) => setTimeout(() => fetch(channel, callback), 0);
    const staged = s.Runtime.stageAssets();
    assert.equal(s.writes.length, 0);
    await staged;
    assert.ok(s.files.has(s.root + "/runtime/bootstrap.py"));
    assert.equal(s.legacyReads.length, 0);
});

test("invalid UTF-8 and malformed manifest bytes fail without exposing source text", async () => {
    for (const bytes of [new Uint8Array([0xff, ...new TextEncoder().encode("synthetic-private-manifest")]), new TextEncoder().encode('{"synthetic-private-manifest":')]) {
        const s = setup(); const base = await bundledFixture(s);
        s.assets.set(base + "runtime-manifest.json", bytes);
        await assert.rejects(s.Runtime.stageAssets(), (error: Error) => {
            assert.match(error.message, /bundled.*manifest/i);
            assert.doesNotMatch(error.message, /synthetic-private/);
            return true;
        });
        assert.equal(s.channels.length, 1);
        assert.equal(s.streams[0].closes, 1);
        assert.equal(s.writes.length, 0);
    }
});

test("later source checksum failures do not publish earlier verified native assets", async () => {
    const s = setup(); const first = s.encoder.encode("first synthetic source");
    const base = await bundledFixture(s, first);
    const manifest = JSON.parse(new TextDecoder().decode(s.assets.get(base + "runtime-manifest.json") as Uint8Array));
    manifest.files.push({ path: "runtime/security.py", size: 3, sha256: "a".repeat(64) });
    s.assets.set(base + "runtime-manifest.json", s.encoder.encode(JSON.stringify(manifest)));
    s.assets.set(base + "runtime/security.py", s.encoder.encode("bad"));
    await assert.rejects(s.Runtime.stageAssets(), /checksum/i);
    assert.equal(s.channels.length, 3);
    assert.equal(s.writes.length, 0);
    assert.ok(s.streams.every(stream => stream.closes === 1));
});

test("bundled source reads never use HTTP, fetch or Zotero File text readers", async () => {
    const s = setup(); await bundledFixture(s);
    const forbidden = () => { throw new Error("legacy HTTP/text reader must not run"); };
    s.context.Zotero.File.getContentsFromURLAsync = forbidden;
    s.context.Zotero.HTTP.request = forbidden;
    s.context.fetch = forbidden;
    await s.Runtime.stageAssets();
    assert.equal(s.channels.length, 2);
    assert.equal(s.calls.length, 0);
});

test("native EOF closure after an exact binary read preserves verified bytes", async () => {
    for (const empty of [false, true]) {
        const s = setup(); s.context.rootURI = "jar:file:///synthetic/addon.xpi!/";
        const bytes = empty ? new Uint8Array() : new Uint8Array([0xef, 0xbb, 0xbf, ...s.encoder.encode("公开源代码\r\n"), 0, 0xff]);
        await bundledFixture(s, bytes, true);
        s.native.postException = Object.assign(new Error("synthetic-private-normal-EOF"), { result: s.context.Components.results.NS_BASE_STREAM_CLOSED });
        await s.Runtime.stageAssets();
        assert.deepEqual(s.files.get(s.root + "/runtime/bootstrap.py"), bytes);
        assert.ok(s.streams.every(stream => stream.availabilityChecks === 2 && stream.closes === 1));
    }
});

test("native EOF closure is never accepted before an exact read or after a short read", async () => {
    for (const mode of ["pre", "short"]) {
        const s = setup(); await bundledFixture(s);
        const closed = Object.assign(new Error("synthetic-private-closed"), { result: s.context.Components.results.NS_BASE_STREAM_CLOSED });
        if (mode === "pre") s.native.preException = closed;
        else { s.native.shortRead = true; s.native.postException = closed; }
        await assert.rejects(s.Runtime.stageAssets(), /bundled|asset/i);
        assert.equal(s.streams[0].availabilityChecks, 1);
        assert.equal(s.streams[0].closes, 1);
        assert.equal(s.writes.length, 0);
    }
});

test("post-read errors need the exact native closed result and cannot use messages or coercion", async () => {
    for (const error of [new Error("NS_BASE_STREAM_CLOSED"), { result: "0x80470002" }, { result: 0x80004005 }, null]) {
        const s = setup(); await bundledFixture(s); s.native.postException = error;
        await assert.rejects(s.Runtime.stageAssets(), /bundled|asset/i);
        assert.equal(s.streams[0].availabilityChecks, 2);
        assert.equal(s.streams[0].closes, 1);
        assert.equal(s.writes.length, 0);
    }
});

test("positive post-read remaining bytes still reject an apparently complete source", async () => {
    const s = setup(); await bundledFixture(s); s.native.postRemaining = 1;
    await assert.rejects(s.Runtime.stageAssets(), /bundled|asset/i);
    assert.equal(s.streams[0].availabilityChecks, 2);
    assert.equal(s.streams[0].closes, 1);
    assert.equal(s.writes.length, 0);
});

test("native callback uses Components.isSuccessCode and accepts nonzero successful nsresults", async () => {
    const s = setup(); await bundledFixture(s); s.native.status = 1;
    await s.Runtime.stageAssets();
    assert.deepEqual(s.statusChecks, [1, 1]);
    assert.ok(s.files.has(s.root + "/runtime/bootstrap.py"));
});

test("failed native status closes the supplied stream before any bytes are read or files written", async () => {
    const s = setup(); await bundledFixture(s); s.native.status = 0x80004005;
    await assert.rejects(s.Runtime.stageAssets(), /bundled|asset/i);
    assert.deepEqual(s.statusChecks, [0x80004005]);
    assert.equal(s.streams[0].reads, 0);
    assert.equal(s.streams[0].closes, 1);
    assert.equal(s.writes.length, 0);
});

test("native binary read and wrapper failures close streams and hide private exception details", async () => {
    for (const failure of ["readError", "availableError", "shortRead", "createError", "attachError"] as const) {
        const s = setup(); await bundledFixture(s); s.native[failure] = true;
        await assert.rejects(s.Runtime.stageAssets(), (error: Error) => {
            assert.match(error.message, /bundled|asset/i);
            assert.doesNotMatch(error.message, /synthetic-private/);
            return true;
        });
        assert.equal(s.streams[0].closes, 1, failure);
        assert.equal(s.writes.length, 0);
    }
});

test("oversized or invalid native manifest lengths fail before allocating a binary buffer", async () => {
    for (const length of [64 * 1024 + 1, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        const s = setup(); const base = await bundledFixture(s);
        s.native.reportedSizes.set(base + "runtime-manifest.json", length);
        await assert.rejects(s.Runtime.stageAssets(), /bundled|asset/i);
        assert.equal(s.streams[0].reads, 0);
        assert.equal(s.streams[0].closes, 1);
        assert.equal(s.writes.length, 0);
    }
});

test("native source length exceeding the manifest bound cannot publish any staged file", async () => {
    const s = setup(); const bytes = s.encoder.encode("synthetic public source");
    const base = await bundledFixture(s, bytes);
    s.native.reportedSizes.set(base + "runtime/bootstrap.py", bytes.length + 1);
    await assert.rejects(s.Runtime.stageAssets(), /bundled|asset/i);
    assert.equal(s.streams.at(-1).reads, 0);
    assert.equal(s.writes.length, 0);
});

test("bundled native readers reject remote and unreviewed URI schemes before opening a channel", async () => {
    for (const rootURI of ["https://synthetic.invalid/", "jar:https://synthetic.invalid/addon.xpi!/", "data:synthetic/"]) {
        const s = setup(); s.context.rootURI = rootURI; await bundledFixture(s);
        await assert.rejects(s.Runtime.stageAssets(), /bundled|asset/i);
        assert.equal(s.channels.length, 0);
        assert.equal(s.requests.length, 0);
        assert.equal(s.writes.length, 0);
    }
});

test("staged source assets are hashed before any write and paths are constrained", async () => {
    const s = setup();
    s.assets.set("resource://test/content/runtime/runtime-manifest.json", JSON.stringify({ version: "0.1.0", files: [{ path: "runtime/bootstrap.py", size: 4, sha256: "a".repeat(64) }] }));
    s.assets.set("resource://test/content/runtime/runtime/bootstrap.py", "text");
    await assert.rejects(s.Runtime.stageAssets(), /checksum/i);
    assert.equal(s.files.has(s.root + "/runtime/bootstrap.py"), false);
});

test("bad binary checksum fails before extracting or executing the download", async () => {
    const s = setup();
    await assert.rejects(s.Runtime.downloadUv(), /checksum/i);
    assert.equal(s.calls.length, 0);
    assert.equal(s.files.has(s.root + "/bin/uv"), false);
});

function candidateInstaller(s: ReturnType<typeof setup>, probe: (root: string) => number = () => 3) {
    const staged: string[] = [];
    s.Runtime.stageAssets = async (target = s.Runtime.root) => {
        staged.push(target); s.writes.push(target + "/runtime/bootstrap.py"); s.files.set(target + "/runtime/bootstrap.py", "new helper");
    };
    s.Runtime.downloadUv = async (target = s.Runtime.root) => { s.writes.push(target + "/bin/uv"); return target + "/bin/uv"; };
    s.setQuiet(async (command: string, args: string[]) => {
        const operation = args.at(-1);
        if (operation === "probe") return probe(command.split("/server/")[0]);
        if (operation === "install" || operation === "repair") {
            const target = command.split("/server/")[0];
            s.files.set(target + "/installation.json", JSON.stringify({ version: "0.1.0", python: "3.12.13", state: "ready" }));
            s.files.set(target + "/server/.server-venv/bin/python", "candidate Python");
            s.files.set(target + "/server/zotero-pdf2zh-next-venv/bin/python", "candidate engine");
            s.files.set(target + "/service-token", "b".repeat(64));
        }
        return 0;
    });
    return staged;
}

test("verified source staging honors its explicit candidate root without replacing active files", async () => {
    const s = setup(); s.installed();
    const target = s.root + "-12345678-1234-4123-8123-123456789abc";
    const text = "public helper source", bytes = s.encoder.encode(text);
    const sha256 = Buffer.from(await webcrypto.subtle.digest("SHA-256", bytes)).toString("hex");
    s.assets.set("resource://test/content/runtime/runtime-manifest.json", JSON.stringify({ version: "0.1.0", files: [{ path: "runtime/bootstrap.py", size: bytes.length, sha256 }] }));
    s.assets.set("resource://test/content/runtime/runtime/bootstrap.py", text);
    await s.Runtime.stageAssets(target);
    assert.equal(s.files.get(s.root + "/runtime/bootstrap.py"), "helper");
    assert.deepEqual(s.files.get(target + "/runtime/bootstrap.py"), bytes);
    assert.ok(s.writes.every(file => file.startsWith(target + "/")));
});

test("verified uv archive extraction and publication stay inside the explicit candidate root", async () => {
    const s = setup(); s.installed();
    const target = s.root + "-12345678-1234-4123-8123-123456789abc";
    const digest = Buffer.from(await webcrypto.subtle.digest("SHA-256", new Uint8Array(8))).toString("hex");
    const asset = s.manifest.platformAsset(); s.manifest.platformAsset = () => ({ ...asset, sha256: digest });
    s.setQuiet(async (command: string, args: string[]) => {
        assert.equal(command, "/usr/bin/tar");
        const directory = args[args.indexOf("-C") + 1];
        assert.ok(directory.startsWith(target + "/downloads/"));
        assert.equal(args.at(-1), "uv-test/uv");
        s.files.set(directory + "/uv", s.encoder.encode("synthetic verified uv"));
        return 0;
    });
    assert.equal(await s.Runtime.downloadUv(target), target + "/bin/uv");
    assert.ok(s.files.has(target + "/uv-info.json"));
    assert.ok(s.writes.every(file => file.startsWith(target + "/")));
    assert.equal(s.Runtime.root, s.root);
});

test("runtimeDirectory accepts only this-version UUID leaves and rejects traversal or foreign versions", () => {
    const s = setup();
    assert.equal(s.Runtime.root, s.root);
    const leaf = "runtime-0.1.0-12345678-1234-4123-8123-123456789abc";
    s.prefs.set("runtimeDirectory", leaf);
    assert.equal(s.Runtime.root, "/profile/pdf2zh-easy/" + leaf);
    for (const invalid of ["../escape", "/tmp/escape", "runtime-9.0.0-12345678-1234-4123-8123-123456789abc", leaf + "/escape", "runtime-0.1.0-not-uuid", 7]) {
        s.prefs.set("runtimeDirectory", invalid);
        assert.throws(() => s.Runtime.root, /runtime|location|directory/i);
    }
});

test("installed marker state and Python version use the same acceptance rules as bootstrap", async () => {
    const s = setup(); s.installed();
    assert.equal(await s.Runtime.isInstalled(), true);
    for (const marker of [{ version: "0.1.0", state: "error" }, { version: "0.1.0", state: "installing" }, { version: "0.1.0", python: "3.11.0" }, { version: "0.1.0", python: null }, [], null]) {
        s.files.set(s.root + "/installation.json", JSON.stringify(marker));
        assert.equal(await s.Runtime.isInstalled(), false);
    }
});

test("a corrupt marker never bypasses the busy-service guard before staging", async () => {
    const s = setup(); s.installed();
    s.files.set(s.root + "/installation.json", JSON.stringify({ version: "0.1.0", state: "error" }));
    const staged = candidateInstaller(s, () => 0);
    await assert.rejects(s.Runtime.install(true), /running|busy/i);
    assert.equal(staged.length, 0); assert.equal(s.writes.length, 0); assert.equal(s.pointerWrites.length, 0);
});

test("fresh install writes only a UUID candidate and activates it after both idle probes", async () => {
    const s = setup(); const staged = candidateInstaller(s);
    await s.Runtime.install(true);
    assert.equal(staged.length, 1);
    const target = staged[0];
    assert.match(target, /^\/profile\/pdf2zh-easy\/runtime-0\.1\.0-[a-f0-9-]{36}$/);
    assert.notEqual(target, s.root);
    assert.ok(s.writes.every(file => file.startsWith(target + "/") || file === target));
    assert.equal(s.Runtime.root, target);
    assert.equal(s.pointerWrites.length, 1);
    const venv = s.calls.find(call => call[1][0] === "venv");
    assert.equal(venv[1][1], target + "/server/.server-venv");
    assert.equal(venv[3].UV_PYTHON_INSTALL_DIR, target + "/python");
    assert.equal(venv[3].UV_CACHE_DIR, target + "/cache");
    assert.equal(venv[1].includes("--managed-python"), true);
    assert.equal(venv[1][venv[1].indexOf("--python") + 1], "3.12.13");
    assert.equal(s.calls.filter(call => call[1].at(-1) === "probe").length, 1);
});

test("repair keeps old assets and auth root stable until successful activation", async () => {
    const s = setup(); s.installed();
    const before = new Map(s.files); const staged = candidateInstaller(s);
    const run = s.Runtime.downloadUv;
    s.Runtime.downloadUv = async (target: string) => {
        assert.equal(s.Runtime.root, s.root);
        await s.Runtime.fetch("http://127.0.0.1:8891/api/tasks");
        assert.equal(s.requests.at(-1).opts.headers.get("X-PDF2zh-Easy-Token"), "a".repeat(64));
        return run(target);
    };
    await s.Runtime.install(true, true);
    for (const [name, value] of before) assert.equal(s.files.get(name), value);
    assert.notEqual(staged[0], s.root);
    assert.ok(s.calls.filter(call => call[1].at(-1) === "probe").length >= 3);
    await s.Runtime.fetch("http://127.0.0.1:8891/api/tasks");
    assert.equal(s.requests.at(-1).opts.headers.get("X-PDF2zh-Easy-Token"), "b".repeat(64));
});

test("failed candidate never changes the pointer or any active file", async () => {
    const s = setup(); s.installed(); const before = new Map(s.files);
    candidateInstaller(s);
    s.Runtime.downloadUv = async () => { throw new Error("synthetic download failure"); };
    await assert.rejects(s.Runtime.install(true, true));
    assert.equal(s.Runtime.root, s.root); assert.equal(s.pointerWrites.length, 0);
    for (const [name, value] of before) assert.equal(s.files.get(name), value);
});

test("a newly busy active service prevents candidate activation", async () => {
    const s = setup(); s.installed(); let oldProbes = 0;
    candidateInstaller(s, root => root === s.root ? (++oldProbes === 1 ? 3 : 0) : 3);
    await assert.rejects(s.Runtime.install(true, true), /running|busy/i);
    assert.equal(s.Runtime.root, s.root); assert.equal(s.pointerWrites.length, 0);
});

test("a busy candidate or unknown probe result cannot activate", async () => {
    for (const code of [0, 1, 9]) {
        const s = setup(); candidateInstaller(s, () => code);
        await assert.rejects(s.Runtime.install(true), /running|busy|verified|idle/i);
        assert.equal(s.pointerWrites.length, 0); assert.equal(s.Runtime.root, s.root);
    }
});

test("a partial active tree with lock or PID evidence fails closed without a runnable probe", async () => {
    const s = setup(); s.files.set(s.root + "/service.lock", "existing lifetime lock");
    const staged = candidateInstaller(s);
    await assert.rejects(s.Runtime.install(true), /verified|idle|incomplete/i);
    assert.equal(staged.length, 0); assert.equal(s.writes.length, 0);
});

test("an independently changed active pointer is never overwritten by a candidate commit", async () => {
    const s = setup(); candidateInstaller(s);
    const foreign = "runtime-0.1.0-12345678-1234-4123-8123-123456789abc";
    const download = s.Runtime.downloadUv;
    s.Runtime.downloadUv = async (target: string) => { s.prefs.set("runtimeDirectory", foreign); return download(target); };
    await assert.rejects(s.Runtime.install(true), /changed|activated/);
    assert.equal(s.prefs.get("runtimeDirectory"), foreign);
    assert.equal(s.pointerWrites.length, 0);
});

test("a failed preference commit leaves the previous runtime selected", async () => {
    const s = setup(); candidateInstaller(s);
    s.prefs.set = () => { throw new Error("synthetic pref write failure"); };
    await assert.rejects(s.Runtime.install(true), /pref write failure/);
    assert.equal(s.Runtime.root, s.root);
    assert.equal(s.prefs.has("runtimeDirectory"), false);
});

test("a pre-existing UUID candidate directory is never reused or modified", async () => {
    const s = setup(); const staged = candidateInstaller(s);
    const uuid = "12345678-1234-4123-8123-123456789abc", candidate = s.root + "-" + uuid;
    s.context.Zotero.getMainWindow = () => ({ crypto: { randomUUID: () => uuid } });
    s.io.makeDirectory = async (target: string, options?: any) => {
        assert.equal(target, candidate); assert.equal(options.ignoreExisting, false);
        throw new Error("synthetic existing candidate");
    };
    await assert.rejects(s.Runtime.install(true), /existing candidate/);
    assert.equal(staged.length, 0); assert.equal(s.pointerWrites.length, 0);
});

test("candidate readiness marker is validated before activation", async () => {
    const s = setup(); candidateInstaller(s);
    s.setQuiet(async (command: string, args: string[]) => {
        if (args.at(-1) === "probe") return 3;
        if (args.at(-1) === "install") {
            const target = command.split("/server/")[0];
            s.files.set(target + "/installation.json", JSON.stringify({ version: "0.1.0", state: "error", python: "3.12.13" }));
            s.files.set(target + "/server/.server-venv/bin/python", "exists");
            s.files.set(target + "/server/zotero-pdf2zh-next-venv/bin/python", "exists");
        }
        return 0;
    });
    await assert.rejects(s.Runtime.install(true), /installation|installed|candidate/i);
    assert.equal(s.pointerWrites.length, 0); assert.equal(s.Runtime.root, s.root);
});

test("install waits for an already preparing helper without creating an ensure-install cycle", async () => {
    const s = setup(); s.installed();
    const events: string[] = [];
    let started!: () => void, finish!: () => void;
    const running = new Promise<void>(resolve => { started = resolve; });
    const done = new Promise<void>(resolve => { finish = resolve; });
    s.setQuiet(async (_command: string, args: string[]) => {
        if (args.at(-1) === "ensure") { events.push("ensure-start"); started(); await done; events.push("ensure-end"); return 0; }
        if (args.at(-1) === "probe") { events.push("probe"); return 0; }
        return 0;
    });
    const ready = s.Runtime.ensureReady(); await running;
    const install = s.Runtime.install(true, true).catch((error: Error) => error);
    await new Promise<void>(resolve => setImmediate(resolve));
    const whilePreparing = events.slice();
    finish(); await ready;
    assert.match(String(await install), /running|busy/i);
    assert.deepEqual(whilePreparing, ["ensure-start"]);
    assert.deepEqual(events, ["ensure-start", "ensure-end", "probe"]);
});
