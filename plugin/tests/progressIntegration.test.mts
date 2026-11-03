import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

function setup() {
    const windows: any[] = [];
    const cards = new Map<any, any>();
    const delays: Array<{ ms: number; run: () => void }> = [];
    let cardCalls = 0;
    function window() {
        const win = {};
        windows.push(win);
        return win;
    }
    const imports: any = {
        "../utils/prefs": { getPref: () => true },
        "../utils/locale": { getString: (key: string, data?: any) => key + (data ? JSON.stringify(data) : "") },
        "./progressCard": { ProgressCard: {
            forWindow(win: any) {
                cardCalls++;
                if (!cards.has(win)) cards.set(win, {
                    lines: [] as any[], closed: false,
                    createLine(line: any) { this.lines.push(line); },
                    changeLine({ idx, ...line }: any) { this.lines[idx] = line; },
                    show() {}, close() { this.closed = true; },
                });
                return cards.get(win);
            },
            dispose(win: any) { cards.get(win)?.close(); cards.delete(win); },
        } },
    };
    const source = fs.readFileSync(new URL("../src/modules/pdf2zhHelper.ts", import.meta.url), "utf8") + "\nexport { JobProgressPopup };";
    const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const exports: any = {};
    const context = vm.createContext({
        Zotero: { getMainWindow: () => windows[0], getMainWindows: () => windows, Promise: { delay: (ms: number) => ({ then: (run: () => void) => delays.push({ ms, run }) }) } },
        ztoolkit: { ProgressWindow: class { constructor() { throw new Error("Native popup allocation is forbidden"); } }, log() {} },
    });
    vm.runInContext(`(function(require,exports){${js}\n})`, context)((name: string) => imports[name] || {}, exports);
    return { window, windows, cards, delays, Popup: exports.JobProgressPopup, Factory: exports.PDF2zhHelperFactory, cardCalls: () => cardCalls };
}
const running = { current: 1, total: 1, phase: "running", percent: 22, fileName: "first.pdf", endpoint: "translate" };

test("translation batches use the main-window card, never native popups", () => {
    const s = setup();
    const win = s.window();
    const a = s.Popup.open(["first.pdf"]);
    s.Popup.open(["second.pdf"]);
    assert.equal(s.cardCalls(), 1);
    const lines = s.cards.get(win).lines;
    assert.equal(lines.length, 4);
    a.updateFile(running);
    assert.ok(lines[1].progress > 0);
});

test("closing all windows buffers progress and reopening restores active lines", () => {
    const s = setup();
    const first = s.window();
    const batch = s.Popup.open(["first.pdf"]);
    const oldCard = s.cards.get(first);
    s.Factory.disposeProgressWindow(first);
    s.windows.length = 0;
    batch.updateFile({ ...running, percent: 47 });
    assert.equal(oldCard.closed, true);
    const next = s.window();
    s.Factory.registerProgressWindow(next);
    assert.equal(s.cards.get(next).lines.length, 2);
    assert.match(s.cards.get(next).lines[1].text, /47/);
    const other = s.window();
    s.Factory.registerProgressWindow(other);
    batch.updateFile({ ...running, percent: 61 });
    assert.equal(s.cards.get(next).lines[1].text, s.cards.get(other).lines[1].text);
});

test("a batch started without a main window is restored on load", () => {
    const s = setup();
    const batch = s.Popup.open(["first.pdf"]);
    batch.updateFile(running);
    const win = s.window();
    s.Factory.registerProgressWindow(win);
    assert.equal(s.cards.get(win).lines.length, 2);
    assert.ok(s.cards.get(win).lines[1].progress > 0);
});

test("failures remain expandable instead of being dismissed after eight seconds", () => {
    const s = setup();
    const win = s.window();
    const batch = s.Popup.open(["first.pdf"]);
    batch.updateFile({ ...running, phase: "file-failed", message: "API unavailable" });
    batch.complete(0, 1);
    s.delays.forEach(delay => delay.run());
    assert.equal(s.cards.get(win).closed, false);
    assert.equal(s.cards.get(win).lines[1].type, "error");
});

test("success dismisses after 8000ms but a new batch invalidates the old delay", () => {
    const s = setup();
    const win = s.window();
    const first = s.Popup.open(["first.pdf"]);
    first.complete(1, 0);
    assert.equal(s.delays[0].ms, 8000);
    const next = s.Popup.open(["second.pdf"]);
    s.delays[0].run();
    assert.equal(s.cards.get(win).closed, false);
    next.complete(1, 0);
    const card = s.cards.get(win);
    s.delays[1].run();
    assert.equal(card.closed, true);
});

test("shutdown disposes all views and stale completion cannot close a fresh session", () => {
    const s = setup();
    const win = s.window();
    const old = s.Popup.open(["old.pdf"]);
    old.complete(1, 0);
    const oldCard = s.cards.get(win);
    s.Factory.disposeProgress();
    assert.equal(oldCard.closed, true);
    const next = s.Popup.open(["next.pdf"]);
    next.complete(1, 0);
    s.delays[0].run();
    assert.equal(s.cards.get(win).closed, false);
    old.updateFile(running);
    assert.equal(s.cards.get(win).lines.length, 2);
    const card = s.cards.get(win);
    s.delays[1].run();
    assert.equal(card.closed, true);
});

test("duplicate completion does not decrement another active batch", () => {
    const s = setup();
    const win = s.window();
    const first = s.Popup.open(["first.pdf"]);
    s.Popup.open(["second.pdf"]);
    first.complete(1, 0);
    first.complete(1, 0);
    s.delays.forEach(delay => delay.run());
    assert.equal(s.cards.get(win).closed, false);
    assert.equal(s.delays.length, 0);
});
