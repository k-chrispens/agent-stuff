/**
 * Socket management utilities for session control.
 *
 * Handles socket paths, alias symlinks, liveness checks, and session discovery.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { SocketState, LiveSessionInfo } from "./control-types.ts";
import { promises as fs } from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

export const CONTROL_DIR = path.join(os.homedir(), ".pi", "session-control");
export const SOCKET_SUFFIX = ".sock";

// ============================================================================
// Validation
// ============================================================================

export function isSafeSessionId(sessionId: string): boolean {
	return !sessionId.includes("/") && !sessionId.includes("\\") && !sessionId.includes("..") && sessionId.length > 0;
}

export function isSafeAlias(alias: string): boolean {
	return !alias.includes("/") && !alias.includes("\\") && !alias.includes("..") && alias.length > 0;
}

// ============================================================================
// Paths
// ============================================================================

export function getSocketPath(sessionId: string): string {
	return path.join(CONTROL_DIR, `${sessionId}${SOCKET_SUFFIX}`);
}

function getAliasPath(alias: string): string {
	return path.join(CONTROL_DIR, `${alias}.alias`);
}

// ============================================================================
// Errno helpers
// ============================================================================

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
	return typeof error === "object" && error !== null && "code" in error;
}

function isEnoent(error: unknown): boolean {
	return isErrnoException(error) && error.code === "ENOENT";
}

// ============================================================================
// Directory & Socket Management
// ============================================================================

export async function ensureControlDir(): Promise<void> {
	await fs.mkdir(CONTROL_DIR, { recursive: true });
}

export async function removeSocket(socketPath: string | null): Promise<void> {
	if (!socketPath) return;
	try {
		await fs.unlink(socketPath);
	} catch (error: unknown) {
		if (!isEnoent(error)) {
			const message = error instanceof Error ? error.message : String(error);
			process.stderr.write(`[control] Failed to remove socket ${socketPath}: ${message}\n`);
		}
	}
}

export async function removeAliasesForSocket(socketPath: string | null): Promise<void> {
	if (!socketPath) return;
	try {
		const entries = await fs.readdir(CONTROL_DIR, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isSymbolicLink()) continue;
			const aliasPath = path.join(CONTROL_DIR, entry.name);
			let target: string;
			try {
				target = await fs.readlink(aliasPath);
			} catch {
				// Symlink unreadable — skip
				continue;
			}
			const resolvedTarget = path.resolve(CONTROL_DIR, target);
			if (resolvedTarget === socketPath) {
				await fs.unlink(aliasPath);
			}
		}
	} catch (error: unknown) {
		if (!isEnoent(error)) {
			const message = error instanceof Error ? error.message : String(error);
			process.stderr.write(`[control] Failed to remove aliases for ${socketPath}: ${message}\n`);
		}
	}
}

// ============================================================================
// Alias Management
// ============================================================================

export function getSessionAlias(ctx: ExtensionContext): string | null {
	const sessionName = ctx.sessionManager.getSessionName();
	const alias = sessionName ? sessionName.trim() : "";
	if (!alias || !isSafeAlias(alias)) return null;
	return alias;
}

export async function createAliasSymlink(sessionId: string, alias: string): Promise<void> {
	if (!alias || !isSafeAlias(alias)) return;
	const aliasPath = getAliasPath(alias);
	const target = `${sessionId}${SOCKET_SUFFIX}`;
	try {
		await fs.unlink(aliasPath);
	} catch (error: unknown) {
		if (!isEnoent(error)) {
			const message = error instanceof Error ? error.message : String(error);
			process.stderr.write(`[control] Failed to remove old alias ${aliasPath}: ${message}\n`);
		}
	}
	try {
		await fs.symlink(target, aliasPath);
	} catch (error: unknown) {
		if (isErrnoException(error) && error.code !== "EEXIST") {
			const message = error instanceof Error ? error.message : String(error);
			process.stderr.write(`[control] Failed to create alias symlink ${aliasPath}: ${message}\n`);
		}
	}
}

export async function resolveSessionIdFromAlias(alias: string): Promise<string | null> {
	if (!alias || !isSafeAlias(alias)) return null;
	const aliasPath = getAliasPath(alias);
	try {
		const target = await fs.readlink(aliasPath);
		const resolvedTarget = path.resolve(CONTROL_DIR, target);
		const base = path.basename(resolvedTarget);
		if (!base.endsWith(SOCKET_SUFFIX)) return null;
		const sessionId = base.slice(0, -SOCKET_SUFFIX.length);
		return isSafeSessionId(sessionId) ? sessionId : null;
	} catch {
		// Alias symlink doesn't exist or is unreadable
		return null;
	}
}

export async function syncAlias(state: SocketState, ctx: ExtensionContext): Promise<void> {
	if (!state.server || !state.socketPath) return;
	const alias = getSessionAlias(ctx);
	if (alias && alias !== state.alias) {
		await removeAliasesForSocket(state.socketPath);
		await createAliasSymlink(ctx.sessionManager.getSessionId(), alias);
		state.alias = alias;
		return;
	}
	if (!alias && state.alias) {
		await removeAliasesForSocket(state.socketPath);
		state.alias = null;
	}
}

// ============================================================================
// Liveness & Discovery
// ============================================================================

async function isSocketAlive(socketPath: string): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = net.createConnection(socketPath);
		const timeout = setTimeout(() => {
			socket.destroy();
			resolve(false);
		}, 300);

		const cleanup = (alive: boolean) => {
			clearTimeout(timeout);
			socket.removeAllListeners();
			resolve(alive);
		};

		socket.once("connect", () => {
			socket.end();
			cleanup(true);
		});
		socket.once("error", () => {
			cleanup(false);
		});
	});
}

async function getAliasMap(): Promise<Map<string, string[]>> {
	const aliasMap = new Map<string, string[]>();
	let entries: Awaited<ReturnType<typeof fs.readdir>>;
	try {
		entries = await fs.readdir(CONTROL_DIR, { withFileTypes: true });
	} catch {
		// Control dir doesn't exist yet — no aliases
		return aliasMap;
	}
	for (const entry of entries) {
		if (!entry.isSymbolicLink()) continue;
		if (!entry.name.endsWith(".alias")) continue;
		const aliasPath = path.join(CONTROL_DIR, entry.name);
		let target: string;
		try {
			target = await fs.readlink(aliasPath);
		} catch {
			// Symlink unreadable — skip
			continue;
		}
		const resolvedTarget = path.resolve(CONTROL_DIR, target);
		const aliases = aliasMap.get(resolvedTarget);
		const aliasName = entry.name.slice(0, -".alias".length);
		if (aliases) {
			aliases.push(aliasName);
		} else {
			aliasMap.set(resolvedTarget, [aliasName]);
		}
	}
	return aliasMap;
}

export async function getLiveSessions(): Promise<LiveSessionInfo[]> {
	await ensureControlDir();
	let entries: Awaited<ReturnType<typeof fs.readdir>>;
	try {
		entries = await fs.readdir(CONTROL_DIR, { withFileTypes: true });
	} catch {
		// Control dir doesn't exist — no sessions
		return [];
	}
	const aliasMap = await getAliasMap();
	const sessions: LiveSessionInfo[] = [];

	for (const entry of entries) {
		if (!entry.name.endsWith(SOCKET_SUFFIX)) continue;
		const socketPath = path.join(CONTROL_DIR, entry.name);
		const alive = await isSocketAlive(socketPath);
		if (!alive) continue;
		const sessionId = entry.name.slice(0, -SOCKET_SUFFIX.length);
		if (!isSafeSessionId(sessionId)) continue;
		const aliases = aliasMap.get(socketPath) ?? [];
		const name = aliases[0];
		sessions.push({ sessionId, name, aliases, socketPath });
	}

	sessions.sort((a, b) => (a.name ?? a.sessionId).localeCompare(b.name ?? b.sessionId));
	return sessions;
}
