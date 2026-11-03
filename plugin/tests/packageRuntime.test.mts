import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

test("runtime package contains only reviewed source assets with hashes, not personal runtime data", () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    execFileSync(process.execPath, [path.join(root, "scripts/package-runtime.cjs")], { cwd: root, windowsHide: true });
    const assets = path.join(root, "plugin/addon/content/runtime");
    const manifest = JSON.parse(fs.readFileSync(path.join(assets, "runtime-manifest.json"), "utf8"));
    assert.equal(manifest.version, "0.1.0");
    assert.ok(manifest.files.some((entry: any) => entry.path === "runtime/bootstrap.py"));
    assert.ok(manifest.files.some((entry: any) => entry.path === "server/utils/silent_process.py"));
    const names = new Set();
    for (const entry of manifest.files) {
        assert.ok(!names.has(entry.path)); names.add(entry.path);
        assert.ok(!/(?:\.venv|venv\/|__pycache__|\.log$|service-token|translated\/|config\.(?:json|toml)$)/.test(entry.path), entry.path);
        const bytes = fs.readFileSync(path.join(assets, entry.path));
        assert.equal(entry.sha256, createHash("sha256").update(bytes).digest("hex"));
        assert.equal(entry.size, bytes.length);
        assert.ok(bytes.length < 1024 * 1024);
    }
});
