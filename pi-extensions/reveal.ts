import { existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@mariozechner/pi-tui";

type ContentBlock = {
	type?: string;
	text?: string;
	arguments?: Record<string, unknown>;
};

type FileReference = {
	path: string;
	display: string;
	exists: boolean;
	isDirectory: boolean;
};

const FILE_TAG_REGEX = /<file\s+name=["']([^"']+)["']>/g;
const FILE_URL_REGEX = /file:\/\/[^\s"'<>]+/g;
const PATH_REGEX = /(?:^|[\s"'`([{<])((?:~|\/)[^\s"'`<>)}\]]+)/g;

const extractFileReferencesFromText = (text: string): string[] => {
	const refs: string[] = [];

	for (const match of text.matchAll(FILE_TAG_REGEX)) {
		refs.push(match[1]);
	}

	for (const match of text.matchAll(FILE_URL_REGEX)) {
		refs.push(match[0]);
	}

	for (const match of text.matchAll(PATH_REGEX)) {
		refs.push(match[1]);
	}

	return refs;
};

const extractPathsFromToolArgs = (args: unknown): string[] => {
	if (!args || typeof args !== "object") {
		return [];
	}

	const refs: string[] = [];
	const record = args as Record<string, unknown>;
	const directKeys = ["path", "file", "filePath", "filepath", "fileName", "filename"] as const;
	const listKeys = ["paths", "files", "filePaths"] as const;

	for (const key of directKeys) {
		const value = record[key];
		if (typeof value === "string") {
			refs.push(value);
		}
	}

	for (const key of listKeys) {
		const value = record[key];
		if (Array.isArray(value)) {
			for (const item of value) {
				if (typeof item === "string") {
					refs.push(item);
				}
			}
		}
	}

	return refs;
};

const extractFileReferencesFromContent = (content: unknown): string[] => {
	if (typeof content === "string") {
		return extractFileReferencesFromText(content);
	}

	if (!Array.isArray(content)) {
		return [];
	}

	const refs: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") {
			continue;
		}

		const block = part as ContentBlock;

		if (block.type === "text" && typeof block.text === "string") {
			refs.push(...extractFileReferencesFromText(block.text));
		}

		if (block.type === "toolCall") {
			refs.push(...extractPathsFromToolArgs(block.arguments));
		}
	}

	return refs;
};

const extractFileReferencesFromEntry = (entry: SessionEntry): string[] => {
	if (entry.type === "message") {
		return extractFileReferencesFromContent(entry.message.content);
	}

	if (entry.type === "custom_message") {
		return extractFileReferencesFromContent(entry.content);
	}

	return [];
};

const sanitizeReference = (raw: string): string => {
	let value = raw.trim();
	value = value.replace(/^["'`(<\[]+/, "");
	value = value.replace(/[>"'`,;).\]]+$/, "");
	value = value.replace(/[.,;:]+$/, "");
	return value;
};

const normalizeReferencePath = (raw: string, cwd: string): string | null => {
	let candidate = sanitizeReference(raw);
	if (!candidate) {
		return null;
	}

	if (candidate.startsWith("file://")) {
		try {
			candidate = fileURLToPath(candidate);
		} catch {
			return null;
		}
	}

	if (candidate.startsWith("~")) {
		candidate = path.join(os.homedir(), candidate.slice(1));
	}

	if (!path.isAbsolute(candidate)) {
		candidate = path.resolve(cwd, candidate);
	}

	return candidate;
};

const formatDisplayPath = (absolutePath: string, cwd: string): string => {
	const normalizedCwd = path.resolve(cwd);
	if (absolutePath.startsWith(normalizedCwd + path.sep)) {
		return path.relative(normalizedCwd, absolutePath);
	}
	return absolutePath;
};

const collectRecentFileReferences = (entries: SessionEntry[], cwd: string, limit: number): FileReference[] => {
	const results: FileReference[] = [];
	const seen = new Set<string>();

	for (let i = entries.length - 1; i >= 0 && results.length < limit; i -= 1) {
		const refs = extractFileReferencesFromEntry(entries[i]);
		for (let j = refs.length - 1; j >= 0 && results.length < limit; j -= 1) {
			const normalized = normalizeReferencePath(refs[j], cwd);
			if (!normalized || seen.has(normalized)) {
				continue;
			}

			seen.add(normalized);

			let exists = false;
			let isDirectory = false;
			if (existsSync(normalized)) {
				exists = true;
				const stats = statSync(normalized);
				isDirectory = stats.isDirectory();
			}

			results.push({
				path: normalized,
				display: formatDisplayPath(normalized, cwd),
				exists,
				isDirectory,
			});
		}
	}

	return results;
};

const findLatestFileReference = (entries: SessionEntry[], cwd: string): FileReference | null => {
	const refs = collectRecentFileReferences(entries, cwd, 1);
	return refs[0] ?? null;
};

const showFileSelector = async (ctx: ExtensionContext, items: FileReference[]): Promise<FileReference | null> => {
	const selectItems: SelectItem[] = items.map((item) => ({
		value: item.path,
		label: item.display,
		description: !item.exists ? "missing" : item.isDirectory ? "directory" : "",
	}));

	return ctx.ui.custom<FileReference | null>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Select a file to reveal"))));

		const selectList = new SelectList(selectItems, Math.min(selectItems.length, 12), {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});

		selectList.searchable = true;

		selectList.onSelect = (item) => {
			const selected = items.find((entry) => entry.path === item.value);
			done(selected ?? null);
		};
		selectList.onCancel = () => done(null);

		container.addChild(selectList);
		container.addChild(new Text(theme.fg("dim", "Type to filter • enter to select • esc to cancel")));
		container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

		return {
			render(width: number) {
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				selectList.handleInput(data);
				tui.requestRender();
			},
		};
	});
};

const showActionSelector = async (ctx: ExtensionContext, canQuickLook: boolean): Promise<"reveal" | "quicklook" | null> => {
	const actions: SelectItem[] = [
		{ value: "reveal", label: "Reveal in Finder" },
		...(canQuickLook ? [{ value: "quicklook", label: "Open in Quick Look" }] : []),
	];

	return ctx.ui.custom<"reveal" | "quicklook" | null>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Choose action"))));

		const selectList = new SelectList(actions, actions.length, {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});

		selectList.onSelect = (item) => done(item.value as "reveal" | "quicklook");
		selectList.onCancel = () => done(null);

		container.addChild(selectList);
		container.addChild(new Text(theme.fg("dim", "Press enter to confirm or esc to cancel")));
		container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

		return {
			render(width: number) {
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				selectList.handleInput(data);
				tui.requestRender();
			},
		};
	});
};

const revealPath = async (pi: ExtensionAPI, ctx: ExtensionContext, target: FileReference): Promise<void> => {
	if (!existsSync(target.path)) {
		if (ctx.hasUI) {
			ctx.ui.notify(`File not found: ${target.path}`, "error");
		}
		return;
	}

	const isDirectory = target.isDirectory || statSync(target.path).isDirectory();
	let command = "open";
	let args: string[] = [];

	if (process.platform === "darwin") {
		args = isDirectory ? [target.path] : ["-R", target.path];
	} else {
		command = "xdg-open";
		args = [isDirectory ? target.path : path.dirname(target.path)];
	}

	const result = await pi.exec(command, args);
	if (result.code !== 0 && ctx.hasUI) {
		const errorMessage = result.stderr?.trim() || `Failed to reveal ${target.path}`;
		ctx.ui.notify(errorMessage, "error");
	}
};

const quickLookPath = async (pi: ExtensionAPI, ctx: ExtensionContext, target: FileReference): Promise<void> => {
	if (process.platform !== "darwin") {
		if (ctx.hasUI) {
			ctx.ui.notify("Quick Look is only available on macOS", "warning");
		}
		return;
	}

	if (!existsSync(target.path)) {
		if (ctx.hasUI) {
			ctx.ui.notify(`File not found: ${target.path}`, "error");
		}
		return;
	}

	const isDirectory = target.isDirectory || statSync(target.path).isDirectory();
	if (isDirectory) {
		if (ctx.hasUI) {
			ctx.ui.notify("Quick Look only works on files", "warning");
		}
		return;
	}

	const result = await pi.exec("qlmanage", ["-p", target.path]);
	if (result.code !== 0 && ctx.hasUI) {
		const errorMessage = result.stderr?.trim() || `Failed to Quick Look ${target.path}`;
		ctx.ui.notify(errorMessage, "error");
	}
};

export default function (pi: ExtensionAPI): void {
	pi.registerCommand("reveal", {
		description: "Reveal or Quick Look files mentioned in the conversation",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("Reveal requires interactive mode", "error");
				return;
			}

			const entries = ctx.sessionManager.getBranch();
			const references = collectRecentFileReferences(entries, ctx.cwd, 100);

			if (references.length === 0) {
				ctx.ui.notify("No file reference found in the session", "warning");
				return;
			}

			const selection = await showFileSelector(ctx, references);
			if (!selection) {
				ctx.ui.notify("Reveal cancelled", "info");
				return;
			}

			if (!selection.exists) {
				ctx.ui.notify(`File not found: ${selection.path}`, "error");
				return;
			}

			const canQuickLook = process.platform === "darwin" && !selection.isDirectory;
			if (process.platform === "darwin") {
				const action = await showActionSelector(ctx, canQuickLook);
				if (!action) {
					ctx.ui.notify("Reveal cancelled", "info");
					return;
				}

				if (action === "quicklook") {
					await quickLookPath(pi, ctx, selection);
					return;
				}
			}

			await revealPath(pi, ctx, selection);
		},
	});

	pi.registerShortcut("ctrl+f", {
		description: "Reveal the latest file reference in Finder",
		handler: async (ctx) => {
			const entries = ctx.sessionManager.getBranch();
			const latest = findLatestFileReference(entries, ctx.cwd);

			if (!latest) {
				if (ctx.hasUI) {
					ctx.ui.notify("No file reference found in the session", "warning");
				}
				return;
			}

			await revealPath(pi, ctx, latest);
		},
	});

	pi.registerShortcut("ctrl+shift+f", {
		description: "Quick Look the latest file reference",
		handler: async (ctx) => {
			const entries = ctx.sessionManager.getBranch();
			const latest = findLatestFileReference(entries, ctx.cwd);

			if (!latest) {
				if (ctx.hasUI) {
					ctx.ui.notify("No file reference found in the session", "warning");
				}
				return;
			}

			await quickLookPath(pi, ctx, latest);
		},
	});
}
