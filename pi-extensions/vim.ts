/**
 * Vim Mode Extension
 *
 * Adds vim-style modal editing to the pi input editor.
 *
 * Modes:
 * - INSERT: default, all keys pass through to the editor
 * - NORMAL: navigation and editing via vim keybindings
 * - VISUAL: character-wise selection (not yet implemented)
 *
 * Normal mode bindings:
 *   Movement:    h j k l  w b e  0 $ ^  gg G  { }
 *   Editing:     i I a A o O  x X  dd D C  cc S  r  J  p
 *   Delete:      dw db d$ d0  diw
 *   Change:      cw cb c$ c0  ciw
 *   Yank:        yy yw yb y$ y0 yiw
 *   Undo:        u
 *   Search:      f F (single-char jump)
 *   Counts:      prefix any motion/action with a number
 *
 * Insert mode exits to normal via Escape.
 * In normal mode, Escape passes through (abort agent, etc).
 *
 * Usage: pi -e ./pi-extensions/vim.ts
 */

import { CustomEditor, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

// Escape sequences for cursor/editing operations the base Editor understands
const SEQ = {
	left: "\x1b[D",
	right: "\x1b[C",
	up: "\x1b[A",
	down: "\x1b[B",
	home: "\x01",      // ctrl+a — line start
	end: "\x05",       // ctrl+e — line end
	delete: "\x1b[3~", // forward delete
	backspace: "\x7f",
	wordBack: "\x1bb",  // alt+b
	wordFwd: "\x1bf",   // alt+f
	killLineEnd: "\x0b",   // ctrl+k — delete to end of line
	killLineStart: "\x15", // ctrl+u — delete to start of line
	killWordBack: "\x17",  // ctrl+w — delete word backwards
	killWordFwd: "\x1bd",  // alt+d — delete word forward
	newline: "\n",
	undo: "\x1a",       // ctrl+z
	yank: "\x19",       // ctrl+y — yank from kill ring
} as const;

type Mode = "normal" | "insert";
type Pending = "d" | "c" | "y" | "f" | "F" | "r" | "g" | null;

class VimEditor extends CustomEditor {
	private mode: Mode = "insert";
	private pending: Pending = null;
	private count = 0;
	private register = "";

	private getCount(): number {
		const n = this.count || 1;
		this.count = 0;
		return n;
	}

	private resetPending() {
		this.pending = null;
		this.count = 0;
	}

	private emit(seq: string, n = 1) {
		for (let i = 0; i < n; i++) super.handleInput(seq);
	}

	private get lines(): string[] { return this.getLines(); }
	private get curLine(): string { return this.lines[this.getCursor().line] ?? ""; }
	private get col(): number { return this.getCursor().col; }
	private get line(): number { return this.getCursor().line; }

	// ---- word boundary helpers ----

	private isWordChar(c: string): boolean {
		return /\w/.test(c);
	}

	private wordEndForward(): number {
		const line = this.curLine;
		let i = this.col + 1;
		while (i < line.length && !this.isWordChar(line[i]!)) i++;
		while (i < line.length && this.isWordChar(line[i]!)) i++;
		return i;
	}

	private wordStartBackward(): number {
		const line = this.curLine;
		let i = this.col - 1;
		while (i > 0 && !this.isWordChar(line[i]!)) i--;
		while (i > 0 && this.isWordChar(line[i - 1]!)) i--;
		return Math.max(0, i);
	}

	private innerWordBounds(): [number, number] {
		const line = this.curLine;
		const c = this.col;
		if (c >= line.length) return [c, c];
		const isW = this.isWordChar(line[c]!);
		let start = c, end = c;
		if (isW) {
			while (start > 0 && this.isWordChar(line[start - 1]!)) start--;
			while (end < line.length && this.isWordChar(line[end]!)) end++;
		} else {
			while (start > 0 && !this.isWordChar(line[start - 1]!) && line[start - 1] !== " ") start--;
			while (end < line.length && !this.isWordChar(line[end]!) && line[end] !== " ") end++;
		}
		return [start, end];
	}

	// ---- text manipulation via the editor's own methods ----

	private deleteRange(from: number, to: number) {
		if (from >= to) return;
		const saved = this.curLine.slice(from, to);
		this.register = saved;
		// move to `from`, then forward-delete (to - from) chars
		this.emit(SEQ.home);
		this.emit(SEQ.right, from);
		this.emit(SEQ.delete, to - from);
	}

	private yankRange(from: number, to: number) {
		if (from >= to) return;
		this.register = this.curLine.slice(from, to);
	}

	// ---- operator dispatch ----

	private applyOperator(op: "d" | "c" | "y", from: number, to: number) {
		if (op === "y") {
			this.yankRange(from, to);
		} else {
			this.deleteRange(from, to);
			if (op === "c") this.mode = "insert";
		}
	}

	// ---- handle pending operator + motion ----

	private handleOperatorMotion(motion: string) {
		const op = this.pending as "d" | "c" | "y";
		const n = this.getCount();
		this.pending = null;

		const c = this.col;
		const line = this.curLine;

		switch (motion) {
			case "w": {
				let end = c;
				for (let i = 0; i < n; i++) {
					let j = end + 1;
					while (j < line.length && !this.isWordChar(line[j]!)) j++;
					while (j < line.length && this.isWordChar(line[j]!)) j++;
					end = j;
				}
				this.applyOperator(op, c, Math.min(end, line.length));
				break;
			}
			case "b": {
				let start = c;
				for (let i = 0; i < n; i++) {
					let j = start - 1;
					while (j > 0 && !this.isWordChar(line[j]!)) j--;
					while (j > 0 && this.isWordChar(line[j - 1]!)) j--;
					start = Math.max(0, j);
				}
				this.applyOperator(op, start, c);
				if (op !== "y") {
					this.emit(SEQ.home);
					this.emit(SEQ.right, start);
				}
				break;
			}
			case "$":
				this.applyOperator(op, c, line.length);
				break;
			case "0":
				this.applyOperator(op, 0, c);
				if (op !== "y") {
					this.emit(SEQ.home);
				}
				break;
			case "d":
			case "c":
			case "y": {
				// dd, cc, yy — operate on whole line(s)
				const lines = this.lines;
				const lineIdx = this.line;
				if (op === "y") {
					const endIdx = Math.min(lineIdx + n, lines.length);
					this.register = lines.slice(lineIdx, endIdx).join("\n") + "\n";
				} else {
					// delete n lines: go to start, kill to end, then delete the newlines
					this.emit(SEQ.home);
					for (let i = 0; i < n; i++) {
						this.emit(SEQ.killLineEnd);
						// if not last line, delete the newline char too
						if (this.line < lines.length - 1 || i < n - 1) {
							this.emit(SEQ.delete);
						}
					}
					if (op === "c") this.mode = "insert";
				}
				break;
			}
			default:
				break;
		}
	}

	// ---- handle pending f/F (find char) ----

	private handleFindChar(char: string) {
		const direction = this.pending === "f" ? 1 : -1;
		const n = this.getCount();
		this.pending = null;
		const line = this.curLine;
		let pos = this.col;

		for (let i = 0; i < n; i++) {
			pos += direction;
			while (pos >= 0 && pos < line.length && line[pos] !== char) pos += direction;
			if (pos < 0 || pos >= line.length) return; // not found
		}

		const delta = pos - this.col;
		if (delta > 0) this.emit(SEQ.right, delta);
		else if (delta < 0) this.emit(SEQ.left, -delta);
	}

	// ---- inner word for di/ci/yi ----

	private handleInnerWord(op: "d" | "c" | "y") {
		const [start, end] = this.innerWordBounds();
		this.applyOperator(op, start, end);
		if (op !== "y") {
			this.emit(SEQ.home);
			this.emit(SEQ.right, start);
		}
	}

	handleInput(data: string): void {
		// Escape: insert→normal, normal→pass through (abort agent etc)
		if (matchesKey(data, "escape")) {
			if (this.mode === "insert") {
				this.mode = "normal";
				this.resetPending();
				return;
			}
			if (this.pending) {
				this.resetPending();
				return;
			}
			super.handleInput(data);
			return;
		}

		// Insert mode: everything goes to the editor
		if (this.mode === "insert") {
			super.handleInput(data);
			return;
		}

		// ---- NORMAL MODE ----

		// Pending replace: next char replaces char under cursor
		if (this.pending === "r") {
			this.pending = null;
			if (data.length === 1 && data.charCodeAt(0) >= 32) {
				this.emit(SEQ.delete);
				super.handleInput(data);
				this.emit(SEQ.left);
			}
			return;
		}

		// Pending f/F: next char is the search target
		if (this.pending === "f" || this.pending === "F") {
			if (data.length === 1 && data.charCodeAt(0) >= 32) {
				this.handleFindChar(data);
			} else {
				this.resetPending();
			}
			return;
		}

		// Pending g: waiting for second char
		if (this.pending === "g") {
			this.pending = null;
			if (data === "g") {
				// gg — go to first line
				this.emit(SEQ.up, this.line);
				this.emit(SEQ.home);
			}
			this.count = 0;
			return;
		}

		// Pending operator waiting for i (inner)
		if ((this.pending === "d" || this.pending === "c" || this.pending === "y") && data === "i") {
			// Next char determines the text object
			// We'll handle 'w' for inner word — store a sub-pending
			const op = this.pending;
			this.pending = null;
			// Wait for next char inline — but we can't do sub-pending easily,
			// so just handle 'iw' as a special sequence by setting a flag
			// Actually, let's just peek: the user types diw as d-i-w, and we get
			// 'i' here. We need to wait for 'w'. Use a trick: temporarily set pending.
			const self = this;
			const origHandleInput = this.handleInput.bind(this);
			this.handleInput = function (nextData: string) {
				self.handleInput = origHandleInput;
				if (nextData === "w") {
					self.handleInnerWord(op);
				}
				self.count = 0;
			};
			return;
		}

		// Pending operator + motion
		if (this.pending === "d" || this.pending === "c" || this.pending === "y") {
			if ("wb$0".includes(data) || data === this.pending) {
				this.handleOperatorMotion(data);
				return;
			}
			// Unknown motion — cancel
			this.resetPending();
			return;
		}

		// Digit — accumulate count (0 without count = line start)
		if (data >= "1" && data <= "9") {
			this.count = this.count * 10 + parseInt(data);
			return;
		}
		if (data === "0" && this.count > 0) {
			this.count = this.count * 10;
			return;
		}

		const n = this.getCount();

		switch (data) {
			// -- movement --
			case "h": this.emit(SEQ.left, n); break;
			case "j": this.emit(SEQ.down, n); break;
			case "k": this.emit(SEQ.up, n); break;
			case "l": this.emit(SEQ.right, n); break;
			case "w": this.emit(SEQ.wordFwd, n); break;
			case "b": this.emit(SEQ.wordBack, n); break;
			case "e": {
				// end of word: move forward by word then back one
				for (let i = 0; i < n; i++) {
					this.emit(SEQ.wordFwd);
					this.emit(SEQ.left);
				}
				break;
			}
			case "0": this.emit(SEQ.home); break;
			case "$": this.emit(SEQ.end); break;
			case "^": {
				this.emit(SEQ.home);
				const line = this.curLine;
				let i = 0;
				while (i < line.length && line[i] === " ") i++;
				if (i > 0) this.emit(SEQ.right, i);
				break;
			}
			case "G": {
				// go to last line
				this.emit(SEQ.down, this.lines.length - 1 - this.line);
				this.emit(SEQ.end);
				break;
			}
			case "g":
				this.pending = "g";
				this.count = n; // preserve count for gg
				break;
			case "{": {
				// paragraph up: find previous blank line
				let target = this.line - 1;
				while (target > 0 && this.lines[target]?.trim() !== "") target--;
				if (target < this.line) this.emit(SEQ.up, this.line - target);
				break;
			}
			case "}": {
				// paragraph down: find next blank line
				let target = this.line + 1;
				while (target < this.lines.length && this.lines[target]?.trim() !== "") target++;
				if (target > this.line) this.emit(SEQ.down, target - this.line);
				break;
			}

			// -- mode switches --
			case "i": this.mode = "insert"; break;
			case "I":
				this.emit(SEQ.home);
				this.mode = "insert";
				break;
			case "a":
				this.emit(SEQ.right);
				this.mode = "insert";
				break;
			case "A":
				this.emit(SEQ.end);
				this.mode = "insert";
				break;
			case "o":
				this.emit(SEQ.end);
				super.handleInput(SEQ.newline);
				this.mode = "insert";
				break;
			case "O":
				this.emit(SEQ.home);
				super.handleInput(SEQ.newline);
				this.emit(SEQ.up);
				this.mode = "insert";
				break;

			// -- single-key edits --
			case "x": this.emit(SEQ.delete, n); break;
			case "X": this.emit(SEQ.backspace, n); break;
			case "D": this.emit(SEQ.killLineEnd); break;
			case "C":
				this.emit(SEQ.killLineEnd);
				this.mode = "insert";
				break;
			case "S":
				this.emit(SEQ.home);
				this.emit(SEQ.killLineEnd);
				this.mode = "insert";
				break;
			case "J": {
				// join line below
				if (this.line < this.lines.length - 1) {
					this.emit(SEQ.end);
					this.emit(SEQ.delete); // delete the newline
					// ensure a space between joined content
					const nextChar = this.curLine[this.col];
					if (nextChar && nextChar !== " ") {
						super.handleInput(" ");
					}
				}
				break;
			}
			case "r":
				this.pending = "r";
				break;
			case "p": {
				// paste register after cursor
				if (this.register) {
					if (this.register.endsWith("\n")) {
						// line-wise paste: insert below
						this.emit(SEQ.end);
						super.handleInput(SEQ.newline);
						const content = this.register.slice(0, -1);
						for (const ch of content) super.handleInput(ch);
					} else {
						this.emit(SEQ.right);
						for (const ch of this.register) super.handleInput(ch);
						this.emit(SEQ.left);
					}
				}
				break;
			}

			// -- operators --
			case "d": this.pending = "d"; this.count = n; break;
			case "c": this.pending = "c"; this.count = n; break;
			case "y": this.pending = "y"; this.count = n; break;

			// -- find --
			case "f": this.pending = "f"; this.count = n; break;
			case "F": this.pending = "F"; this.count = n; break;

			// -- undo --
			case "u": this.emit(SEQ.undo, n); break;

			// -- pass control sequences through --
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

		const modeStr = this.mode === "normal"
			? (this.pending ? ` NORMAL (${this.pending}${this.count || ""}) ` : " NORMAL ")
			: " INSERT ";

		const last = lines.length - 1;
		if (visibleWidth(lines[last]!) >= modeStr.length) {
			lines[last] = truncateToWidth(lines[last]!, width - modeStr.length, "") + modeStr;
		}
		return lines;
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.hasUI) {
			ctx.ui.setEditorComponent((tui, theme, kb) => new VimEditor(tui, theme, kb));
		}
	});
}
