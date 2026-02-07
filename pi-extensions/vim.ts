/**
 * Vim Mode Extension
 *
 * Minimal vim-style modal editing for the pi input editor.
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

const WORD_RE = /\w/;

type Pending = "d" | "c" | "y" | "g" | "r" | null;

/**
 * Check if data is a control/special key sequence that should always
 * pass through to CustomEditor for app-level handling (ctrl+c, ctrl+d, etc.).
 */
function isControlSequence(data: string): boolean {
	return data.length > 1 || data.charCodeAt(0) < 32;
}

class VimEditor extends CustomEditor {
	private mode: "normal" | "insert" = "insert";
	private pending: Pending = null;
	private register = "";

	/** Emit a raw key sequence to the base Editor, bypassing CustomEditor keybindings. */
	private emitRaw(seq: string, n = 1) {
		for (let i = 0; i < n; i++) Editor_handleInput.call(this, seq);
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
		this.emitRaw("\x01"); // home
		this.emitRaw("\x1b[C", from); // right
		this.emitRaw("\x1b[3~", to - from); // delete
	}

	/** Delete from cursor to end of line, saving the removed text to the register. */
	private deleteToEnd() {
		if (this.col < this.curLine.length) {
			this.register = this.curLine.slice(this.col);
		}
		this.emitRaw("\x0b"); // ctrl+k = deleteToLineEnd
	}

	/** Delete n full lines, saving them to the register as line-wise text. */
	private deleteLines(n: number) {
		const lines = this.getLines();
		const idx = this.lineIdx;
		const end = Math.min(idx + n, lines.length);
		this.register = lines.slice(idx, end).join("\n") + "\n";
		this.emitRaw("\x01"); // home
		for (let i = 0; i < n; i++) {
			this.emitRaw("\x0b"); // kill to end
			if (this.lineIdx < lines.length - 1 || i < n - 1) {
				this.emitRaw("\x1b[3~"); // delete (join lines)
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
			case "d":
			case "c":
			case "y": {
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
		// Escape: switch to normal mode from insert, or pass through in normal
		if (matchesKey(data, "escape")) {
			if (this.mode === "insert") {
				this.mode = "normal";
				this.pending = null;
				return;
			}
			// In normal mode, cancel pending or pass through for app handling (abort agent)
			if (this.pending) {
				this.pending = null;
				return;
			}
			super.handleInput(data);
			return;
		}

		// Insert mode: pass everything to CustomEditor
		if (this.mode === "insert") {
			super.handleInput(data);
			return;
		}

		// ---- NORMAL MODE ----

		// CRITICAL: Always pass control sequences through to CustomEditor for
		// app-level handling (ctrl+c to clear, ctrl+d to exit, ctrl+z to suspend, etc.)
		// This must happen regardless of pending state.
		if (isControlSequence(data)) {
			this.pending = null;
			super.handleInput(data);
			return;
		}

		// From here on, data is a single printable character.

		// Pending: replace char under cursor
		if (this.pending === "r") {
			this.pending = null;
			if (this.col < this.curLine.length) {
				this.emitRaw("\x1b[3~"); // delete
				this.insertTextAtCursor(data);
				this.emitRaw("\x1b[D"); // left
			}
			return;
		}

		// Pending: gg
		if (this.pending === "g") {
			this.pending = null;
			if (data === "g") {
				this.emitRaw("\x1b[A", this.lineIdx); // up
				this.emitRaw("\x01"); // home
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
			case "h": this.emitRaw("\x1b[D"); break; // left
			case "j": this.emitRaw("\x1b[B"); break; // down
			case "k": this.emitRaw("\x1b[A"); break; // up
			case "l": this.emitRaw("\x1b[C"); break; // right
			case "w": this.emitRaw("\x1bf"); break; // word forward (alt+f)
			case "b": this.emitRaw("\x1bb"); break; // word backward (alt+b)
			case "e": this.emitRaw("\x1bf"); this.emitRaw("\x1b[D"); break; // word fwd + left
			case "0": this.emitRaw("\x01"); break; // home (ctrl+a)
			case "$": this.emitRaw("\x05"); break; // end (ctrl+e)
			case "^": {
				this.emitRaw("\x01"); // home
				let i = 0;
				const line = this.curLine;
				while (i < line.length && line[i] === " ") i++;
				if (i > 0) this.emitRaw("\x1b[C", i); // right
				break;
			}
			case "G":
				this.emitRaw("\x1b[B", this.getLines().length - 1 - this.lineIdx); // down
				this.emitRaw("\x05"); // end
				break;
			case "g":
				this.pending = "g";
				break;

			// -- enter insert mode --
			case "i": this.mode = "insert"; break;
			case "I": this.emitRaw("\x01"); this.mode = "insert"; break; // home + insert
			case "a": this.emitRaw("\x1b[C"); this.mode = "insert"; break; // right + insert
			case "A": this.emitRaw("\x05"); this.mode = "insert"; break; // end + insert
			case "o":
				this.emitRaw("\x05"); // end
				this.insertTextAtCursor("\n");
				this.mode = "insert";
				break;
			case "O":
				this.emitRaw("\x01"); // home
				this.insertTextAtCursor("\n");
				this.emitRaw("\x1b[A"); // up
				this.mode = "insert";
				break;

			// -- editing --
			case "x": {
				if (this.col < this.curLine.length) {
					this.register = this.curLine[this.col]!;
				}
				this.emitRaw("\x1b[3~"); // delete
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
				this.emitRaw("\x01"); // home
				this.deleteToEnd();
				this.mode = "insert";
				break;
			case "r":
				this.pending = "r";
				break;
			case "J":
				if (this.lineIdx < this.getLines().length - 1) {
					this.emitRaw("\x05"); // end
					this.emitRaw("\x1b[3~"); // delete (join)
					if (this.curLine[this.col] && this.curLine[this.col] !== " ") {
						this.insertTextAtCursor(" ");
					}
				}
				break;
			case "p":
				if (this.register) {
					if (this.register.endsWith("\n")) {
						this.emitRaw("\x05"); // end
						this.insertTextAtCursor("\n" + this.register.slice(0, -1));
					} else {
						this.emitRaw("\x1b[C"); // right
						this.insertTextAtCursor(this.register);
						this.emitRaw("\x1b[D"); // left
					}
				}
				break;
			case "u":
				this.emitRaw("\x1f"); // undo (ctrl+-)
				break;

			// -- operators --
			case "d": this.pending = "d"; break;
			case "c": this.pending = "c"; break;
			case "y": this.pending = "y"; break;

			// Ignore other printable chars in normal mode
			default:
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

// Cache the grandparent (Editor) handleInput for internal key emission,
// bypassing CustomEditor's app-level keybinding checks.
const Editor_handleInput = Object.getPrototypeOf(CustomEditor.prototype).handleInput;

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
