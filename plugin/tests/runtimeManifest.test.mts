import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

function load() {
    const source = fs.readFileSync(new URL("../src/modules/runtimeManifest.ts", import.meta.url), "utf8");
    const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const exports: any = {};
    vm.runInNewContext(`(function(exports){${js}\n})`, {})(exports);
    return exports;
}

test("selects pinned trusted uv assets for the five supported platform combinations", () => {
    const { platformAsset } = load();
    for (const [os, abi, fragment] of [
        ["WINNT", "x86_64-msvc", "x86_64-pc-windows-msvc.zip"],
        ["Darwin", "aarch64-gcc3", "aarch64-apple-darwin.tar.gz"],
        ["Darwin", "x86_64-gcc3", "x86_64-apple-darwin.tar.gz"],
        ["Linux", "x86_64-gcc3", "x86_64-unknown-linux-gnu.tar.gz"],
        ["Linux", "aarch64-gcc3", "aarch64-unknown-linux-gnu.tar.gz"],
    ]) {
        const asset = platformAsset(os, abi);
        assert.ok(asset.url.startsWith("https://github.com/astral-sh/uv/releases/download/0.13.6/"));
        assert.ok(asset.url.endsWith(fragment));
        assert.match(asset.sha256, /^[a-f0-9]{64}$/);
        assert.equal(asset.executable, os === "WINNT" ? "uv.exe" : "uv");
    }
});

test("unsupported CPU or operating system fails explicitly instead of running wrong binary", () => {
    const { platformAsset } = load();
    for (const [os, abi] of [["WINNT", "aarch64-msvc"], ["WINNT", "x86-msvc"], ["FreeBSD", "x86_64"], ["Linux", "armv7"]]) {
        assert.throws(() => platformAsset(os, abi), /Unsupported/);
    }
});

test("runtime asset paths cannot escape the install root", () => {
    const { safeRelativeAsset } = load();
    assert.equal(safeRelativeAsset("server/utils/execute.py"), "server/utils/execute.py");
    for (const value of ["../private", "/absolute", "C:/escape", "a/../b", "a\\b", "a//b", "a\0b", ".", "a/./b"]) {
        assert.throws(() => safeRelativeAsset(value), /asset path/);
    }
});
