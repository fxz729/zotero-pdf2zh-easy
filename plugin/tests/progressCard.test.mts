import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

function setup() {
    class Node {
        tagName: string;
        children: any[] = [];
        attrs: Record<string, string> = {};
        textContent = "";
        hidden = false;
        isConnected = false;
        parent: any;
        listeners: Record<string, () => void> = {};
        constructor(tag: string) { this.tagName = tag; }
        appendChild(child: any) { child.parent = this; child.isConnected = true; this.children.push(child); return child; }
        setAttribute(k: string, v: string) { this.attrs[k] = v; }
        getAttribute(k: string) { return this.attrs[k]; }
        addEventListener(k: string, v: () => void) { this.listeners[k] = v; }
        removeEventListener(k: string, v: () => void) { if (this.listeners[k] === v) delete this.listeners[k]; }
        remove() { this.isConnected = false; if (this.parent) this.parent.children = this.parent.children.filter((n: any) => n !== this); }
    }
    const timers = new Map<number, () => void>();
    let id = 0;
    const doc = { documentElement: new Node("window"), createElementNS: (_ns: string, tag: string) => new Node(tag) };
    const listeners = new Map<string, () => void>();
    const win = { document: doc, addEventListener: (key: string, fn: () => void) => listeners.set(key, fn), removeEventListener: (key: string, fn: () => void) => { if (listeners.get(key) === fn) listeners.delete(key); }, setTimeout: (fn: () => void) => { timers.set(++id, fn); return id; }, clearTimeout: (key: number) => timers.delete(key) };
    const source = fs.readFileSync(new URL("../src/modules/progressCard.ts", import.meta.url), "utf8");
    const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const exports: any = {};
    vm.runInNewContext(`(function(exports){${js}\n})`, {})(exports);
    return { Card: exports.ProgressCard, win, doc, timers, listeners };
}
function descendants(node: any): any[] { return [node, ...node.children.flatMap(descendants)]; }

test("one internal card is shared per main window without native windows", () => {
    const { Card, win, doc } = setup();
    const a = Card.forWindow(win, "PDF2zh");
    assert.equal(a, Card.forWindow(win, "PDF2zh"));
    assert.equal(doc.documentElement.children.length, 1);
    assert.equal(descendants(doc.documentElement).filter(n => n.tagName === "section").length, 1);
});

test("file names are text, progress is clamped, and invalid updates are harmless", () => {
    const { Card, win, doc } = setup();
    const card = Card.forWindow(win, "PDF2zh");
    card.createLine({ text: "<img src=x onerror=alert(1)>", type: "default", progress: 22 });
    card.changeLine({ idx: 0, text: "finished.pdf", type: "success", progress: 120 });
    card.changeLine({ idx: 99, text: "ignored", type: "error", progress: 1 });
    const nodes = descendants(doc.documentElement);
    assert.equal(nodes.some(n => n.tagName === "img"), false);
    assert.ok(nodes.some(n => n.textContent === "finished.pdf"));
    assert.equal(nodes.find(n => n.tagName === "progress").getAttribute("value"), "100");
});

test("collapse survives frequent progress show updates", () => {
    const { Card, win, doc } = setup();
    const card = Card.forWindow(win, "PDF2zh");
    const toggle = descendants(doc.documentElement).find(n => n.tagName === "button");
    toggle.listeners.click();
    card.show();
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    toggle.listeners.click();
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
});

test("new activity cancels dismissal and close permits a fresh card", () => {
    const { Card, win, doc, timers } = setup();
    const card = Card.forWindow(win, "PDF2zh");
    card.startCloseTimer(8000);
    assert.equal(timers.size, 1);
    card.show();
    assert.equal(timers.size, 0);
    card.close();
    assert.equal(doc.documentElement.children.length, 0);
    assert.notEqual(card, Card.forWindow(win, "PDF2zh"));
});

test("unload releases DOM, click listener, unload listener and timer", () => {
    const { Card, win, doc, timers, listeners } = setup();
    const card = Card.forWindow(win, "PDF2zh");
    const toggle = descendants(doc.documentElement).find(n => n.tagName === "button");
    card.startCloseTimer(8000);
    assert.ok(listeners.get("unload"));
    listeners.get("unload")!();
    assert.equal(doc.documentElement.children.length, 0);
    assert.equal(timers.size, 0);
    assert.equal(listeners.size, 0);
    assert.equal(Object.keys(toggle.listeners).length, 0);
});

test("an already queued dismissal cannot close new activity", () => {
    const { Card, win, doc, timers } = setup();
    const card = Card.forWindow(win, "PDF2zh");
    card.startCloseTimer(8000);
    const queued = [...timers.values()][0];
    card.show();
    queued();
    assert.equal(doc.documentElement.children.length, 1);
});

test("errors remain readable and nonfinite progress is safe", () => {
    const { Card, win, doc } = setup();
    const card = Card.forWindow(win, "PDF2zh");
    card.createLine({ text: "API unavailable", type: "error", progress: NaN });
    const nodes = descendants(doc.documentElement);
    assert.ok(nodes.some(n => n.getAttribute("data-state") === "error"));
    assert.equal(nodes.find(n => n.tagName === "progress").getAttribute("value"), "0");
});
