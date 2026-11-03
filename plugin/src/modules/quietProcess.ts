// Mozilla's installed Windows Subprocess worker uses CREATE_NO_WINDOW.
// Unlike nsIProcess, this also hides console-subsystem executables/redirectors.
// No captured child output is returned, logged, or included in errors.
export async function runQuiet(
    command: string,
    args: string[],
    timeoutMs = 45000,
    environment?: Record<string, string | null>,
): Promise<number> {
    if (!/^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(command) || /\0|\.(?:bat|cmd|sh)$/i.test(command)) {
        throw new Error("A fixed absolute executable is required.");
    }
    if (!Array.isArray(args) || args.some(value => typeof value !== "string" || value.includes("\0"))) {
        throw new Error("Invalid background helper arguments.");
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 1800000) {
        throw new Error("Invalid background helper deadline.");
    }
    const { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");
    let child: any;
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = (async () => {
        try {
            child = await Subprocess.call({ command, arguments: args, stderr: "stdout", environment, environmentAppend: true });
            if (expired) {
                await child.kill();
                throw new Error();
            }
            await child.stdin.close();
            // Drain concurrently with wait, including large installer output.
            const drain = (async () => {
                while (await child.stdout.readString()) { /* discard safely */ }
            })();
            const [result] = await Promise.all([child.wait(), drain]);
            return result.exitCode as number;
        } catch {
            throw new Error("Background helper could not start.");
        }
    })();
    const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
            expired = true;
            if (child) void child.kill().catch(() => {});
            reject(new Error("Background helper timed out."));
        }, timeoutMs);
    });
    try {
        return await Promise.race([work, deadline]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}
