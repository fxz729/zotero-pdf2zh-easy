// Pinned binary hashes from GitHub's authenticated release metadata.
// https://github.com/astral-sh/uv/releases/tag/0.13.6
export const RUNTIME_VERSION = "0.1.0";
export const PYTHON_VERSION = "3.12.13";
export const SERVICE_URL = "http://127.0.0.1:8891";
const UV_VERSION = "0.13.6";
const HASHES: Record<string, string> = {
    "x86_64-pc-windows-msvc.zip": "a2a8820d5eea32f08ef467ef3b7f66883a9b076d5737a2fc2fbb5f458d1bb50f",
    "aarch64-apple-darwin.tar.gz": "60fbd5c8a1ed681845eea28d9d622fcde03c51e91a43465b64a1e17db1ed3472",
    "x86_64-apple-darwin.tar.gz": "63ba17fdda55ad1a230d4b37fc6017ffa10c23688c83818bd3bfdf914c652a02",
    "aarch64-unknown-linux-gnu.tar.gz": "229e194255c7958d86d56e8790d969a6f74736592133f0dfd0076f754c642c1d",
    "x86_64-unknown-linux-gnu.tar.gz": "f29c3e94ffabd7e6f3ba521dba169a9b7ec12100bf3257087f0f24f6123f3645",
};

export function platformAsset(os: string, abi: string) {
    const arch = abi.startsWith("x86_64") ? "x86_64" : /^(aarch64|arm64)/.test(abi) ? "aarch64" : "";
    let target: string;
    if (os === "WINNT" && arch === "x86_64") target = `${arch}-pc-windows-msvc.zip`;
    else if (os === "Darwin" && arch) target = `${arch}-apple-darwin.tar.gz`;
    else if (os === "Linux" && arch) target = `${arch}-unknown-linux-gnu.tar.gz`;
    else throw new Error("Unsupported operating system or CPU for the managed translation engine.");
    const sha256 = HASHES[target];
    if (!sha256) throw new Error("Unsupported binary target.");
    return {
        url: `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${target}`,
        sha256,
        executable: os === "WINNT" ? "uv.exe" : "uv",
        archiveEntry: os === "WINNT" ? "uv.exe" : `uv-${target.replace(/\.tar\.gz$/, "")}/uv`,
        format: os === "WINNT" ? "zip" : "tar.gz",
    };
}

export function safeRelativeAsset(path: string): string {
    if (!/^[a-zA-Z0-9_./-]+$/.test(path) || path.startsWith("/") || path.split("/").some(part => !part || part === "." || part === "..")) {
        throw new Error("Invalid runtime asset path.");
    }
    return path;
}
