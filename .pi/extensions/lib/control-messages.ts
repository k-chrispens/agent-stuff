/**
 * Message extraction and sender info utilities for session control.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { TextContent } from "@mariozechner/pi-ai";
import type { ExtractedMessage } from "./control-types.ts";

export const SENDER_INFO_PATTERN = /<sender_info>[\s\S]*?<\/sender_info>/g;

// ============================================================================
// Message Extraction
// ============================================================================

export function getLastAssistantMessage(ctx: ExtensionContext): ExtractedMessage | undefined {
	const branch = ctx.sessionManager.getBranch();

	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "message") {
			const msg = entry.message;
			if ("role" in msg && msg.role === "assistant") {
				const textParts = msg.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text);
				if (textParts.length > 0) {
					return {
						role: "assistant",
						content: textParts.join("\n"),
						timestamp: msg.timestamp,
					};
				}
			}
		}
	}
	return undefined;
}

export function getMessagesSinceLastPrompt(ctx: ExtensionContext): ExtractedMessage[] {
	const branch = ctx.sessionManager.getBranch();
	const messages: ExtractedMessage[] = [];

	let lastUserIndex = -1;
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "message" && "role" in entry.message && entry.message.role === "user") {
			lastUserIndex = i;
			break;
		}
	}

	if (lastUserIndex === -1) return [];

	for (let i = lastUserIndex; i < branch.length; i++) {
		const entry = branch[i];
		if (entry.type === "message") {
			const msg = entry.message;
			if ("role" in msg && (msg.role === "user" || msg.role === "assistant")) {
				const textParts = msg.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text);
				if (textParts.length > 0) {
					messages.push({
						role: msg.role,
						content: textParts.join("\n"),
						timestamp: msg.timestamp,
					});
				}
			}
		}
	}

	return messages;
}

export function getFirstEntryId(ctx: ExtensionContext): string | undefined {
	const entries = ctx.sessionManager.getEntries();
	if (entries.length === 0) return undefined;
	const root = entries.find((e) => e.parentId === null);
	return root?.id ?? entries[0]?.id;
}

// ============================================================================
// Content Extraction
// ============================================================================

export function extractTextContent(content: string | Array<TextContent | { type: string }>): string {
	if (typeof content === "string") return content;
	return content
		.filter((c): c is TextContent => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}

// ============================================================================
// Sender Info
// ============================================================================

export interface SenderInfo {
	sessionId?: string;
	sessionName?: string;
}

export function stripSenderInfo(text: string): string {
	return text.replace(SENDER_INFO_PATTERN, "").trim();
}

export function parseSenderInfo(text: string): SenderInfo | null {
	const match = text.match(/<sender_info>([\s\S]*?)<\/sender_info>/);
	if (!match) return null;
	const raw = match[1].trim();
	if (!raw) return null;

	if (raw.startsWith("{")) {
		try {
			const parsed = JSON.parse(raw) as { sessionId?: unknown; sessionName?: unknown };
			const sessionId = typeof parsed.sessionId === "string" ? parsed.sessionId.trim() : "";
			const sessionName = typeof parsed.sessionName === "string" ? parsed.sessionName.trim() : "";
			if (sessionId || sessionName) {
				return {
					sessionId: sessionId || undefined,
					sessionName: sessionName || undefined,
				};
			}
		} catch {
			// Fall through to legacy parsing
		}
	}

	const legacyIdMatch = raw.match(/session\s+([a-f0-9-]{6,})/i);
	if (legacyIdMatch) {
		return { sessionId: legacyIdMatch[1] };
	}

	return null;
}

export function formatSenderInfo(info: SenderInfo | null): string | null {
	if (!info) return null;
	const { sessionName, sessionId } = info;
	if (sessionName && sessionId) return `${sessionName} (${sessionId})`;
	if (sessionName) return sessionName;
	if (sessionId) return sessionId;
	return null;
}
