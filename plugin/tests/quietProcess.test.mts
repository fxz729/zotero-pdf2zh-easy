import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

function load(call: (opts: any) => any) {
    const source = fs.readFileSync(new URL("../src/modules/quietProcess.ts", import.meta.url), "utf8");
    const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const exports: any = {};
    vm.runInNewContext(`(function(exports){${js}\n})`, {
        ChromeUtils: { importESModule: (name: string) => { assert.equal(name, "resource://gre/modules/Subprocess.sys.mjs"); return { Subprocess: { call } }; } },
        setTimeout, clearTimeout,
    })(exports);
    return exports.runQuiet;
}
const child = (exitCode = 0) => ({ stdout: { readString: async () => "" }, stdin: { close: async () => {} }, wait: async () => ({ exitCode }), kill: async () => {} });

test("uses Mozilla hidden process API with argv, never nsIProcess or a shell", async () => {
    let options: any;
    const run = load(async opts => { options = opts; return child(); });
    assert.equal(await run("C:/Program Files/Python/python.exe", ["中文 helper.py"], 1000), 0);
    assert.equal(options.command, "C:/Program Files/Python/python.exe");
    assert.deepEqual(Array.from(options.arguments), ["中文 helper.py"]);
    assert.equal(options.stderr, "stdout");
});

test("passes a private environment with null removals without editing system settings", async () => {
    let options: any;
    const run = load(async opts => { options = opts; return child(); });
    await run("/usr/bin/python3", [], 1000, { PYTHONPATH: null, UV_CACHE_DIR: "/profile/cache" });
    assert.equal(options.environmentAppend, true);
    assert.equal(options.environment.PYTHONPATH, null);
    assert.equal(options.environment.UV_CACHE_DIR, "/profile/cache");
});

test("refuses relative executables and shell launch files", async () => {
    let calls = 0;
    const run = load(async () => { calls++; return child(); });
    for (const name of ["python", "./python", "C:/bad.cmd", "/tmp/install.sh", "C:/bad\0.exe"]) {
        await assert.rejects(run(name, [], 1000), /executable/);
    }
    assert.equal(calls, 0);
});

test("nonzero exit codes are returned without leaking child output", async () => {
    const c = child(9);
    let reads = 0;
    c.stdout.readString = async () => ++reads === 1 ? "secret-like child text" : "";
    const run = load(async () => c);
    assert.equal(await run("/usr/bin/python3", ["helper.py"], 1000), 9);
    assert.equal(reads, 2);
});

test("a deadline kills the helper and produces only a generic error", async () => {
    const c = child();
    let killed = 0;
    c.wait = () => new Promise(() => {});
    c.kill = async () => { killed++; };
    const run = load(async () => c);
    await assert.rejects(run("/usr/bin/python3", [], 10), /timed out/);
    assert.equal(killed, 1);
});

test("spawn errors do not expose executable paths or child stderr", async () => {
    const run = load(async () => { throw new Error("private-path secret-key"); });
    await assert.rejects(run("/usr/bin/python3", [], 1000), /^Error: Background helper could not start\.$/);
});
