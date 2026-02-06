/**
 * Vim Mode Extension
 *
 * Minimal vim-style modal editing for the pi input editor,
 * comparable to Claude Code's built-in vim setting.
 * Toggle with `/vim` command.
 *
 * Normal mode bindings:
 *   Movement:  h j k l  w b e  0 $ ^  gg G
 *   Enter insert:  i I a A o O
 *   Editing:  x dd D C cc/S r p u
 *   Operators:  d/c/y + w/b/$/0
 *   Yank:  yy
 *
 * Insert mode: all keys pass through normally.
 * Escape: insert→normal. In normal mode, passes through (abort agent, etc).
 *
 * Usage: pi -e ./pi-extensions/vim.ts, then /vim
 */

import { CustomEditor, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

// Key sequences matched by the Editor's keybinding system.
// Only sequences that are NOT intercepted as app actions by CustomEditor.
const SEQ = {
	left: "\x1b[D",
	right: "\x1b[C",
	up: "\x1b[A",
	down: "\x1b[B",
	home: "\x01",        // ctrl+a — cursorLineStart
	end: "\x05",         // ctrl+e — cursorLineEnd
	delete: "\x1b[3~",   // delete — deleteCharForward
	wordBack: "\x1bb",   // alt+b — cursorWordLeft
	wordFwd: "\x1bf",    // alt+f — cursorWordRight
	killLineEnd: "\x0b", // ctrl+k — deleteToLineEnd
	undo: "\x1f",        // ctrl+- — undo (NOT ctrl+z which is suspend)
} as const;

const WORD_RE = /\w/;

type Pending = "d" | "c" | "y" | "g" | "r" | null;

class VimEditor extends CustomEditor {
	private mode: "normal" | "insert" = "insert";
	private pending: Pending = null;
	private register = "";

	private emit(seq: string, n = 1) {
		for (let i = 0; i < n; i++) super.handleInput(seq);
	}

	private get curLine(): string {
		return this.getLines()[this.getCursor().line] ?? "";
	}

	private get col(): number {
		return this.getCursor().col;
	}

	private get lineIdx(): number {
		return this.getCursor().line;
	}

	/** Delete a range on the current line, saving the removed text to the register. */
	private deleteRange(from: number, to: number) {
		if (from >= to) return;
		this.register = this.curLine.slice(from, to);
		this.emit(SEQ.home);
		this.emit(SEQ.right, from);
		this.emit(SEQ.delete, to - from);
	}

	/** Delete from cursor to end of line, saving the removed text to the register. */
	private deleteToEnd() {
		if (this.col < this.curLine.length) {
			this.register = this.curLine.slice(this.col);
		}
		this.emit(SEQ.killLineEnd);
	}

	/** Delete n full lines, saving them to the register as line-wise text. */
	private deleteLines(n: number) {
		const lines = this.getLines();
		const idx = this.lineIdx;
		const end = Math.min(idx + n, lines.length);
		this.register = lines.slice(idx, end).join("\n") + "\n";
		this.emit(SEQ.home);
		for (let i = 0; i < n; i++) {
			this.emit(SEQ.killLineEnd);
			if (this.lineIdx < lines.length - 1 || i < n - 1) {
				this.emit(SEQ.delete);
			}
		}
	}

	/** Find the position one past the end of the next word from cursor. */
	private wordEnd(): number {
		const line = this.curLine;
		let i = this.col + 1;
		while (i < line.length && !WORD_RE.test(line[i]!)) i++;
		while (i < line.length && WORD_RE.test(line[i]!)) i++;
		return Math.min(i, line.length);
	}

	/** Find the start position of the word before cursor. */
	private wordStart(): number {
		const line = this.curLine;
		let i = this.col - 1;
		while (i > 0 && !WORD_RE.test(line[i]!)) i--;
		while (i > 0 && WORD_RE.test(line[i - 1]!)) i--;
		return Math.max(0, i);
	}

	/** Execute an operator (d/c/y) with the given motion. */
	private handleOperator(op: "d" | "c" | "y", motion: string) {
		this.pending = null;
		const c = this.col;

		switch (motion) {
			case "w": {
				const to = this.wordEnd();
				if (op === "y") {
					this.register = this.curLine.slice(c, to);
				} else {
					this.deleteRange(c, to);
					if (op === "c") this.mode = "insert";
				}
				break;
			}
			case "b": {
				const from = this.wordStart();
				if (op === "y") {
					this.register = this.curLine.slice(from, c);
				} else {
					this.deleteRange(from, c);
					if (op === "c") this.mode = "insert";
				}
				break;
			}
			case "$": {
				if (op === "y") {
					this.register = this.curLine.slice(c);
				} else {
					this.deleteToEnd();
					if (op === "c") this.mode = "insert";
				}
				break;
			}
			case "0": {
				if (op === "y") {
					this.register = this.curLine.slice(0, c);
				} else {
					this.deleteRange(0, c);
					if (op === "c") this.mode = "insert";
				}
				break;
			}
			// dd, cc, yy
			case "d": case "c": case "y": {
				if (op === "y") {
					this.register = (this.getLines()[this.lineIdx] ?? "") + "\n";
				} else {
					this.deleteLines(1);
					if (op === "c") this.mode = "insert";
				}
				break;
			}
		}
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			if (this.mode === "insert") {
				this.mode = "normal";
				this.pending = null;
				return;
			}
			if (this.pending) {
				this.pending = null;
				return;
			}
			super.handleInput(data);
			return;
		}

		if (this.mode === "insert") {
			super.handleInput(data);
			return;
		}

		// ---- NORMAL MODE ----

		// Pending: replace char under cursor
		if (this.pending === "r") {
			this.pending = null;
			if (data.length === 1 && data.charCodeAt(0) >= 32) {
				this.emit(SEQ.delete);
				this.insertTextAtCursor(data);
				this.emit(SEQ.left);
			}
			return;
		}

		// Pending: gg
		if (this.pending === "g") {
			this.pending = null;
			if (data === "g") {
				this.emit(SEQ.up, this.lineIdx);
				this.emit(SEQ.home);
			}
			return;
		}

		// Pending: operator awaiting motion
		if (this.pending === "d" || this.pending === "c" || this.pending === "y") {
			if ("wb$0".includes(data) || data === this.pending) {
				this.handleOperator(this.pending, data);
			} else {
				this.pending = null;
			}
			return;
		}

		switch (data) {
			// -- movement --
			case "h": this.emit(SEQ.left); break;
			case "j": this.emit(SEQ.down); break;
			case "k": this.emit(SEQ.up); break;
			case "l": this.emit(SEQ.right); break;
			case "w": this.emit(SEQ.wordFwd); break;
			case "b": this.emit(SEQ.wordBack); break;
			case "e": this.emit(SEQ.wordFwd); this.emit(SEQ.left); break;
			case "0": this.emit(SEQ.home); break;
			case "$": this.emit(SEQ.end); break;
			case "^": {
				this.emit(SEQ.home);
				let i = 0;
				const line = this.curLine;
				while (i < line.length && line[i] === " ") i++;
				if (i > 0) this.emit(SEQ.right, i);
				break;
			}
			case "G":
				this.emit(SEQ.down, this.getLines().length - 1 - this.lineIdx);
				this.emit(SEQ.end);
				break;
			case "g":
				this.pending = "g";
				break;

			// -- enter insert mode --
			case "i": this.mode = "insert"; break;
			case "I": this.emit(SEQ.home); this.mode = "insert"; break;
			case "a": this.emit(SEQ.right); this.mode = "insert"; break;
			case "A": this.emit(SEQ.end); this.mode = "insert"; break;
			case "o":
				this.emit(SEQ.end);
				this.insertTextAtCursor("\n");
				this.mode = "insert";
				break;
			case "O":
				this.emit(SEQ.home);
				this.insertTextAtCursor("\n");
				this.emit(SEQ.up);
				this.mode = "insert";
				break;

			// -- editing --
			case "x": {
				if (this.col < this.curLine.length) {
					this.register = this.curLine[this.col]!;
				}
				this.emit(SEQ.delete);
				break;
			}
			case "D":
				this.deleteToEnd();
				break;
			case "C":
				this.deleteToEnd();
				this.mode = "insert";
				break;
			case "S":
				this.emit(SEQ.home);
				this.deleteToEnd();
				this.mode = "insert";
				break;
			case "r":
				this.pending = "r";
				break;
			case "J":
				if (this.lineIdx < this.getLines().length - 1) {
					this.emit(SEQ.end);
					this.emit(SEQ.delete);
					if (this.curLine[this.col] && this.curLine[this.col] !== " ") {
						this.insertTextAtCursor(" ");
					}
				}
				break;
			case "p":
				if (this.register) {
					if (this.register.endsWith("\n")) {
						this.emit(SEQ.end);
						this.insertTextAtCursor("\n" + this.register.slice(0, -1));
					} else {
						this.emit(SEQ.right);
						this.insertTextAtCursor(this.register);
						this.emit(SEQ.left);
					}
				}
				break;
			case "u":
				this.emit(SEQ.undo);
				break;

			// -- operators --
			case "d": this.pending = "d"; break;
			case "c": this.pending = "c"; break;
			case "y": this.pending = "y"; break;

			// -- pass control sequences through (ctrl+c, arrows, etc.) --
			default:
				if (data.length > 1 || data.charCodeAt(0) < 32) {
					super.handleInput(data);
				}
				break;
		}
	}

	render(width: number): string[] {
		const lines = super.render(width);
		if (lines.length === 0) return lines;

		const label = this.mode === "normal"
			? (this.pending ? ` NORMAL (${this.pending}) ` : " NORMAL ")
			: " INSERT ";
		const last = lines.length - 1;
		if (visibleWidth(lines[last]!) >= label.length) {
			lines[last] = truncateToWidth(lines[last]!, width - label.length, "") + label;
		}
		return lines;
	}
}

export default function (pi: ExtensionAPI) {
	let enabled = false;

	pi.registerCommand("vim", {
		description: "Toggle vim mode for the input editor",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			enabled = !enabled;
			if (enabled) {
				ctx.ui.setEditorComponent((tui, theme, kb) => new VimEditor(tui, theme, kb));
				ctx.ui.notify("Vim mode enabled", "info");
			} else {
				ctx.ui.setEditorComponent(undefined);
				ctx.ui.notify("Vim mode disabled", "info");
			}
		},
	});
}
