/**
 * Vim Mode Extension (with cwd history integration)
 *
 * Minimal vim-style modal editing for the pi input editor.
 * Toggle with `/vim` command.
 *
 * Also seeds the editor with prompt history from the current working directory
 * (absorbs the functionality of cwd-history.ts to avoid setEditorComponent conflicts).
 *
 * Normal mode bindings:
 *   Movement:  h j k l  w b e  0 $ ^  gg G
 *   Enter insert:  i I a A o O
 *   Editing:  x dd D C cc/S r p u
 *   Operators:  d/c/y + w/b/$/0
 *   Yank:  yy
 *
 * Insert mode: all keys pass through normally.
 * Escape/Ctrl+[: insert→normal. In normal mode, passes through (abort agent, etc).
 */

import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

// =============================================================================
// Vim editor
// =============================================================================

const WORD_RE = /\w/;

type Pending = "d" | "c" | "y" | "g" | "r" | null;

/**
 * Check if data is a control/special key sequence that should always
 * pass through to CustomEditor for app-level handling (ctrl+c, ctrl+d, etc.).
 *
 * Distinguishes between:
 * - ANSI escape sequences (start with ESC 0x1b): arrow keys, function keys → true
 * - Single control characters (charCode < 32): ctrl+c, ctrl+d, enter → true
 * - Multi-byte Unicode (surrogate pairs, CJK, emoji): not control → false
 * - Single printable ASCII: regular characters → false
 */
function isControlSequence(data: string): boolean {
	if (data.length === 0) return false;
	const firstChar = data.charCodeAt(0);
	// Single control character (ctrl+c, ctrl+d, enter, tab, etc.)
	if (data.length === 1 && firstChar < 32) return true;
	// ANSI escape sequences start with ESC (0x1b)
	if (firstChar === 0x1b) return true;
	// Everything else (including multi-byte Unicode) is printable
	return false;
}

class VimEditor extends CustomEditor {
	private mode: "normal" | "insert" = "insert";
	private pending: Pending = null;
	private register = "";

	// Border color locking (from cwd-history)
	private lockedBorder = false;
	private _borderColor?: (text: string) => string;

	constructor(
		tui: ConstructorParameters<typeof CustomEditor>[0],
		theme: ConstructorParameters<typeof CustomEditor>[1],
		keybindings: ConstructorParameters<typeof CustomEditor>[2],
	) {
		super(tui, theme, keybindings);
		// Set up border color locking so the app can't override our dynamic color
		delete (this as { borderColor?: (text: string) => string }).borderColor;
		Object.defineProperty(this, "borderColor", {
			get: () => this._borderColor ?? ((text: string) => text),
			set: (value: (text: string) => string) => {
				if (this.lockedBorder) return;
				this._borderColor = value;
			},
			configurable: true,
			enumerable: true,
		});
	}

	lockBorderColor() {
		this.lockedBorder = true;
	}

	/**
	 * Emit a raw key sequence to the base Editor, bypassing CustomEditor keybindings.
	 *
	 * Resolves the Editor (grandparent) handleInput at call time rather than caching
	 * it at module load. This is resilient to prototype chain changes between extension
	 * load and execution. Falls back to super.handleInput if the chain is unexpected.
	 */
	private emitRaw(seq: string, n = 1) {
		const editorHandleInput = resolveEditorHandleInput();
		if (editorHandleInput) {
			for (let i = 0; i < n; i++) editorHandleInput.call(this, seq);
		} else {
			// Prototype chain changed — fall through to CustomEditor.handleInput.
			// Less efficient (app keybindings are checked) but functionally correct.
			for (let i = 0; i < n; i++) super.handleInput(seq);
		}
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

	/** Find the start position of the next word from cursor. */
	private nextWordStart(): number {
		const line = this.curLine;
		let i = this.col;
		if (i >= line.length) return i;
		// Skip through current word characters
		while (i < line.length && WORD_RE.test(line[i]!)) i++;
		// Skip non-word characters (spaces, punctuation)
		while (i < line.length && !WORD_RE.test(line[i]!)) i++;
		return i;
	}

	/** In normal mode, clamp cursor so it doesn't go past the last character. */
	private clampCursor(): void {
		if (this.curLine.length > 0 && this.col >= this.curLine.length) {
			this.emitRaw("\x1b[D"); // left
		}
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

	private isEscape(data: string): boolean {
		return matchesKey(data, "escape") || matchesKey(data, "ctrl+[");
	}

	handleInput(data: string): void {
		// Escape or Ctrl+[: switch to normal mode from insert, or pass through in normal
		if (this.isEscape(data)) {
			if (this.mode === "insert") {
				this.mode = "normal";
				this.pending = null;
				this.clampCursor();
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
			if (this.mode === "normal") this.clampCursor();
			return;
		}

		switch (data) {
			// -- movement --
			case "h": this.emitRaw("\x1b[D"); break; // left
			case "j": this.emitRaw("\x1b[B"); break; // down
			case "k": this.emitRaw("\x1b[A"); break; // up
			case "l": // right (guard: can't move past last character in normal mode)
				if (this.col < this.curLine.length - 1) this.emitRaw("\x1b[C");
				break;
			case "w": { // next word start (uses WORD_RE, not terminal word-jump)
				const target = this.nextWordStart();
				const delta = target - this.col;
				if (delta > 0) this.emitRaw("\x1b[C", delta);
				break;
			}
			case "b": { // previous word start (uses WORD_RE, not terminal word-jump)
				const target = this.wordStart();
				const delta = this.col - target;
				if (delta > 0) this.emitRaw("\x1b[D", delta);
				break;
			}
			case "e": { // end of word (character-level scan with WORD_RE)
				const line = this.curLine;
				let i = this.col + 1;
				while (i < line.length && !WORD_RE.test(line[i]!)) i++;
				while (i < line.length && WORD_RE.test(line[i]!)) i++;
				// i is one past end of word; land ON the last word char
				const target = Math.min(i - 1, line.length - 1);
				const delta = target - this.col;
				if (delta > 0) this.emitRaw("\x1b[C", delta);
				break;
			}
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
					const nextLine = this.getLines()[this.lineIdx + 1] ?? "";
					const leadingSpaces = nextLine.match(/^\s*/)?.[0]?.length ?? 0;
					this.emitRaw("\x05"); // end
					this.emitRaw("\x1b[3~"); // delete newline (join)
					// Strip leading whitespace from the joined portion
					if (leadingSpaces > 0) {
						this.emitRaw("\x1b[3~", leadingSpaces);
					}
					// Ensure there's a space separator
					if (this.col < this.curLine.length && this.curLine[this.col] !== " ") {
						this.insertTextAtCursor(" ");
					}
				}
				break;
			case "p":
				if (this.register) {
					if (this.register.endsWith("\n")) {
						// Line-wise: paste below current line, move to start of pasted line
						const pastedLines = this.register.slice(0, -1).split("\n");
						this.emitRaw("\x05"); // end
						this.insertTextAtCursor("\n" + this.register.slice(0, -1));
						// Navigate back to first pasted line
						if (pastedLines.length > 1) {
							this.emitRaw("\x1b[A", pastedLines.length - 1);
						}
						this.emitRaw("\x01"); // home
					} else {
						this.emitRaw("\x1b[C"); // right
						this.insertTextAtCursor(this.register);
						this.emitRaw("\x1b[D"); // left
					}
				}
				break;
			case "P":
				if (this.register) {
					if (this.register.endsWith("\n")) {
						// Line-wise: paste above current line, move to start of pasted line
						const pastedLines = this.register.slice(0, -1).split("\n");
						this.emitRaw("\x01"); // home
						this.insertTextAtCursor(this.register.slice(0, -1) + "\n");
						// Cursor is on the pushed-down original line; move up to first pasted line
						this.emitRaw("\x1b[A", pastedLines.length);
						this.emitRaw("\x01"); // home
					} else {
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

		// After any normal-mode command, ensure cursor doesn't go past the last character
		if (this.mode === "normal") {
			this.clampCursor();
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

/**
 * Resolve Editor.prototype.handleInput at call time.
 *
 * Walks up from CustomEditor.prototype to find the grandparent (Editor) handleInput,
 * bypassing CustomEditor's app-level keybinding checks. Returns null if the prototype
 * chain is unexpected, so callers can fall back gracefully.
 */
function resolveEditorHandleInput(): ((data: string) => void) | null {
	const editorProto = Object.getPrototypeOf(CustomEditor.prototype);
	if (!editorProto || typeof editorProto.handleInput !== "function") {
		process.stderr.write("[vim] Warning: Editor prototype chain changed — raw key emission will use fallback\n");
		return null;
	}
	return editorProto.handleInput;
}

// =============================================================================
// CWD history (absorbed from cwd-history.ts)
// =============================================================================

const MAX_HISTORY_ENTRIES = 100;
const MAX_RECENT_PROMPTS = 30;

interface PromptEntry {
	text: string;
	timestamp: number;
}

function extractText(content: Array<{ type: string; text?: string }>): string {
	return content
		.filter((item) => item.type === "text" && typeof item.text === "string")
		.map((item) => item.text ?? "")
		.join("")
		.trim();
}

function collectUserPromptsFromEntries(entries: Array<any>): PromptEntry[] {
	const prompts: PromptEntry[] = [];
	for (const entry of entries) {
		if (entry?.type !== "message") continue;
		const message = entry?.message;
		if (!message || message.role !== "user" || !Array.isArray(message.content)) continue;
		const text = extractText(message.content);
		if (!text) continue;
		const timestamp = Number(message.timestamp ?? entry.timestamp ?? Date.now());
		prompts.push({ text, timestamp });
	}
	return prompts;
}

function getSessionDirForCwd(cwd: string): string {
	const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	return path.join(os.homedir(), ".pi", "agent", "sessions", safePath);
}

async function readTail(filePath: string, maxBytes = 256 * 1024): Promise<string> {
	let fileHandle: fs.FileHandle | undefined;
	try {
		const stats = await fs.stat(filePath);
		const size = stats.size;
		const start = Math.max(0, size - maxBytes);
		const length = size - start;
		if (length <= 0) return "";
		const buffer = Buffer.alloc(length);
		fileHandle = await fs.open(filePath, "r");
		const { bytesRead } = await fileHandle.read(buffer, 0, length, start);
		if (bytesRead === 0) return "";
		let chunk = buffer.subarray(0, bytesRead).toString("utf8");
		if (start > 0) {
			const firstNewline = chunk.indexOf("\n");
			if (firstNewline !== -1) {
				chunk = chunk.slice(firstNewline + 1);
			} else {
				// Entire chunk is a partial line — not safe to parse
				return "";
			}
		}
		return chunk;
	} catch {
		// File unreadable (deleted, permissions) — no history from this file
		return "";
	} finally {
		await fileHandle?.close();
	}
}

async function loadPromptHistoryForCwd(cwd: string, excludeSessionFile?: string): Promise<PromptEntry[]> {
	const sessionDir = getSessionDirForCwd(path.resolve(cwd));
	const resolvedExclude = excludeSessionFile ? path.resolve(excludeSessionFile) : undefined;
	const prompts: PromptEntry[] = [];
	let entries: fs.Dirent[] = [];
	try {
		entries = await fs.readdir(sessionDir, { withFileTypes: true });
	} catch {
		// Session dir doesn't exist yet — no history
		return prompts;
	}
	const files = await Promise.all(
		entries
			.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
			.map(async (entry) => {
				const filePath = path.join(sessionDir, entry.name);
				try {
					const stats = await fs.stat(filePath);
					return { filePath, mtimeMs: stats.mtimeMs };
				} catch {
					// File removed between readdir and stat — skip
					return undefined;
				}
			})
	);
	const sortedFiles = files
		.filter((file): file is { filePath: string; mtimeMs: number } => Boolean(file))
		.sort((a, b) => b.mtimeMs - a.mtimeMs);
	for (const file of sortedFiles) {
		if (resolvedExclude && path.resolve(file.filePath) === resolvedExclude) continue;
		const tail = await readTail(file.filePath);
		if (!tail) continue;
		const lines = tail.split("\n").filter(Boolean);
		for (const line of lines) {
			let entry: { type?: string; message?: { role?: string; content?: Array<{ type: string; text?: string }>; timestamp?: number }; timestamp?: number };
			try {
				entry = JSON.parse(line);
			} catch {
				// Malformed JSONL line — skip
				continue;
			}
			if (entry?.type !== "message") continue;
			const message = entry?.message;
			if (!message || message.role !== "user" || !Array.isArray(message.content)) continue;
			const text = extractText(message.content);
			if (!text) continue;
			const timestamp = Number(message.timestamp ?? entry.timestamp ?? Date.now());
			prompts.push({ text, timestamp });
			if (prompts.length >= MAX_RECENT_PROMPTS) break;
		}
		if (prompts.length >= MAX_RECENT_PROMPTS) break;
	}
	return prompts;
}

function buildHistoryList(currentSession: PromptEntry[], previousSessions: PromptEntry[]): PromptEntry[] {
	const all = [...currentSession, ...previousSessions];
	all.sort((a, b) => a.timestamp - b.timestamp);
	const seen = new Set<string>();
	const deduped: PromptEntry[] = [];
	for (const prompt of all) {
		const key = `${prompt.timestamp}:${prompt.text}`;
		if (seen.has(key)) continue;
		seen.add(key);
		deduped.push(prompt);
	}
	return deduped.slice(-MAX_HISTORY_ENTRIES);
}

function historiesMatch(a: PromptEntry[], b: PromptEntry[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i += 1) {
		if (a[i]?.text !== b[i]?.text || a[i]?.timestamp !== b[i]?.timestamp) return false;
	}
	return true;
}

// =============================================================================
// Extension entry point
// =============================================================================

let loadCounter = 0;

function installVimEditor(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	history: PromptEntry[],
) {
	ctx.ui.setEditorComponent((tui, theme, keybindings) => {
		const editor = new VimEditor(tui, theme, keybindings);
		// Dynamic border color (bash mode / thinking level)
		const borderColor = (text: string) => {
			const isBashMode = editor.getText().trimStart().startsWith("!");
			const colorFn = isBashMode
				? ctx.ui.theme.getBashModeBorderColor()
				: ctx.ui.theme.getThinkingBorderColor(pi.getThinkingLevel());
			return colorFn(text);
		};
		editor.borderColor = borderColor;
		editor.lockBorderColor();
		for (const prompt of history) {
			editor.addToHistory?.(prompt.text);
		}
		return editor;
	});
}

function applyVimEditorWithHistory(pi: ExtensionAPI, ctx: ExtensionContext) {
	if (!ctx.hasUI) return;

	const sessionFile = ctx.sessionManager.getSessionFile();
	const currentEntries = ctx.sessionManager.getBranch();
	const currentPrompts = collectUserPromptsFromEntries(currentEntries);
	const immediateHistory = buildHistoryList(currentPrompts, []);

	const currentLoad = ++loadCounter;
	const initialText = ctx.ui.getEditorText();
	installVimEditor(pi, ctx, immediateHistory);

	// Async: load history from other sessions in the same cwd
	void (async () => {
		const previousPrompts = await loadPromptHistoryForCwd(ctx.cwd, sessionFile ?? undefined);
		if (currentLoad !== loadCounter) return;
		if (ctx.ui.getEditorText() !== initialText) return;
		const history = buildHistoryList(currentPrompts, previousPrompts);
		if (historiesMatch(history, immediateHistory)) return;
		installVimEditor(pi, ctx, history);
	})();
}

export default function (pi: ExtensionAPI) {
	let enabled = true;

	pi.on("session_start", (_event, ctx) => {
		if (enabled) applyVimEditorWithHistory(pi, ctx);
	});

	pi.on("session_switch", (_event, ctx) => {
		if (enabled) applyVimEditorWithHistory(pi, ctx);
	});

	pi.registerCommand("vim", {
		description: "Toggle vim mode for the input editor",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			if (enabled) {
				enabled = false;
				ctx.ui.setEditorComponent(undefined);
				ctx.ui.notify("Vim mode disabled", "info");
			} else {
				enabled = true;
				applyVimEditorWithHistory(pi, ctx);
				ctx.ui.notify("Vim mode enabled", "info");
			}
		},
	});
}
