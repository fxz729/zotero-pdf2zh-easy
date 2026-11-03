// PDF2zh Easy: an internal HTML card, never a native progress window.
export interface ProgressLine {
    text: string;
    type: string;
    progress: number;
}

const HTML = "http://www.w3.org/1999/xhtml";
const STYLE = `
.pdf2zh-easy-card {
    position: fixed; left: 16px; bottom: 38px; z-index: 10000;
    width: min(370px, calc(100vw - 32px)); box-sizing: border-box;
    color: #243a38; background: #fafbf8; border: 1px solid #ccd5ce;
    border-radius: 12px; box-shadow: 0 3px 12px #152e2612;
    font: 12px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    overflow: hidden; text-align: left;
}
.pdf2zh-easy-card[hidden], .pdf2zh-easy-card [hidden] { display: none !important; }
.pdf2zh-easy-card header { display: flex; align-items: center; gap: 12px; padding: 11px 14px; }
.pdf2zh-easy-card strong { flex: 1; font-size: 12px; letter-spacing: .03em; }
.pdf2zh-easy-card button { background: transparent; border: 0; border-radius: 5px;
    color: inherit; cursor: pointer; padding: 2px 7px; font-size: 15px; }
.pdf2zh-easy-card button:focus-visible { outline: 2px solid #267c70; }
.pdf2zh-easy-card .easy-lines { max-height: min(270px, 40vh); overflow-y: auto; padding: 0 14px 13px; }
.pdf2zh-easy-card .easy-line { margin-top: 9px; }
.pdf2zh-easy-card .easy-line:first-child { margin-top: 0; }
.pdf2zh-easy-card .easy-label { display: block; overflow-wrap: anywhere;
    display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
.pdf2zh-easy-card progress { display: block; width: 100%; height: 5px; border: 0;
    border-radius: 4px; margin-top: 6px; background: #e4eae5; accent-color: #267c70; }
.pdf2zh-easy-card progress::-moz-progress-bar { background: #267c70; border-radius: 4px; }
.pdf2zh-easy-card [data-state="error"] { color: #ae3c32; }
.pdf2zh-easy-card [data-state="error"] .easy-label { display: block; }
.pdf2zh-easy-card [data-state="error"] progress::-moz-progress-bar { background: #ae3c32; }
.pdf2zh-easy-card [data-state="success"] { color: #267c70; }
@media (prefers-color-scheme: dark) {
    .pdf2zh-easy-card { background: #242c2b; color: #e4ece6; border-color: #46534c; box-shadow: none; }
    .pdf2zh-easy-card progress { background: #3c4741; }
    .pdf2zh-easy-card [data-state="error"] { color: #ffaba0; }
    .pdf2zh-easy-card [data-state="success"] { color: #88d0b9; }
}
@media (prefers-reduced-motion: no-preference) {
    .pdf2zh-easy-card progress::-moz-progress-bar { transition: width .2s ease-out; }
}`;

export class ProgressCard {
    private static cards = new WeakMap<Window, ProgressCard>();
    private root: HTMLElement;
    private body: HTMLElement;
    private toggle: HTMLButtonElement;
    private lines: Array<{ row: HTMLElement; label: HTMLElement; bar: HTMLElement }> = [];
    private timer: number | null = null;
    private collapsed = false;
    private closeToken = 0;
    private onUnload = () => this.close();
    private onToggle = () => {
        this.collapsed = !this.collapsed;
        this.body.hidden = this.collapsed;
        this.toggle.setAttribute("aria-expanded", String(!this.collapsed));
        this.toggle.textContent = this.collapsed ? "+" : "−";
    };

    static forWindow(win: Window, title: string): ProgressCard {
        let card = this.cards.get(win);
        if (!card || !card.root.isConnected) {
            card = new ProgressCard(win, title);
            this.cards.set(win, card);
        }
        return card;
    }

    static dispose(win: Window): void {
        this.cards.get(win)?.close();
    }

    private element(tag: string, className?: string): HTMLElement {
        const node = this.win.document.createElementNS(HTML, tag) as HTMLElement;
        if (className) node.setAttribute("class", className);
        return node;
    }

    private constructor(private win: Window, title: string) {
        this.root = this.element("section", "pdf2zh-easy-card");
        this.root.setAttribute("aria-label", title);
        const style = this.element("style");
        style.textContent = STYLE;
        this.root.appendChild(style);
        const header = this.element("header");
        const heading = this.element("strong");
        heading.textContent = title;
        header.appendChild(heading);
        this.toggle = this.element("button") as HTMLButtonElement;
        this.toggle.setAttribute("type", "button");
        this.toggle.setAttribute("aria-expanded", "true");
        this.toggle.setAttribute("aria-label", "Collapse / expand translation progress");
        this.toggle.textContent = "−";
        this.toggle.addEventListener("click", this.onToggle);
        header.appendChild(this.toggle);
        this.root.appendChild(header);
        this.body = this.element("div", "easy-lines");
        this.body.setAttribute("role", "status");
        this.body.setAttribute("aria-live", "polite");
        this.root.appendChild(this.body);
        this.win.document.documentElement.appendChild(this.root);
        this.win.addEventListener("unload", this.onUnload);
    }

    createLine(line: ProgressLine): void {
        const row = this.element("div", "easy-line");
        const label = this.element("span", "easy-label");
        const bar = this.element("progress");
        bar.setAttribute("max", "100");
        row.appendChild(label);
        row.appendChild(bar);
        this.body.appendChild(row);
        this.lines.push({ row, label, bar });
        this.changeLine({ idx: this.lines.length - 1, ...line });
    }

    changeLine(line: ProgressLine & { idx: number }): void {
        const target = this.lines[line.idx];
        if (!target) return;
        const percent = Number.isFinite(line.progress) ? Math.max(0, Math.min(100, line.progress)) : 0;
        target.label.textContent = line.text;
        target.label.setAttribute("title", line.text);
        target.row.setAttribute("data-state", line.type === "error" || line.type === "success" ? line.type : "default");
        target.bar.setAttribute("value", String(percent));
        target.bar.setAttribute("aria-label", line.text);
    }

    show(): void {
        this.clearTimer();
        this.root.hidden = false;
        // Do not override a user's collapse choice on every polling update.
    }

    startCloseTimer(milliseconds: number): void {
        this.clearTimer();
        const token = this.closeToken;
        this.timer = this.win.setTimeout(() => {
            if (this.closeToken === token) this.close();
        }, milliseconds);
    }

    private clearTimer(): void {
        this.closeToken += 1;
        if (this.timer !== null) this.win.clearTimeout(this.timer);
        this.timer = null;
    }

    close(): void {
        this.clearTimer();
        this.win.removeEventListener("unload", this.onUnload);
        this.toggle.removeEventListener("click", this.onToggle);
        this.root.remove();
        if (ProgressCard.cards.get(this.win) === this) ProgressCard.cards.delete(this.win);
    }
}
