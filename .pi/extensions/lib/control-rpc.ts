/**
 * RPC protocol utilities for session control.
 *
 * Handles command parsing, response/event writing, and the RPC client.
 */

import type {
	RpcCommand,
	RpcResponse,
	RpcEvent,
	RpcSubscribeCommand,
	ExtractedMessage,
	RpcClientOptions,
} from "./control-types.ts";
import * as net from "node:net";

// ============================================================================
// Wire Protocol
// ============================================================================

export function writeResponse(socket: net.Socket, response: RpcResponse): void {
	try {
		socket.write(`${JSON.stringify(response)}\n`);
	} catch {
		// Socket may be closed — safe to ignore
	}
}

export function writeEvent(socket: net.Socket, event: RpcEvent): void {
	try {
		socket.write(`${JSON.stringify(event)}\n`);
	} catch {
		// Socket may be closed — safe to ignore
	}
}

export function parseCommand(line: string): { command?: RpcCommand; error?: string } {
	try {
		const parsed = JSON.parse(line) as RpcCommand;
		if (!parsed || typeof parsed !== "object") {
			return { error: "Invalid command: expected JSON object" };
		}
		if (typeof parsed.type !== "string") {
			return { error: "Missing command type" };
		}
		return { command: parsed };
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		return { error: `Failed to parse command: ${message}` };
	}
}

// ============================================================================
// RPC Client
// ============================================================================

export async function sendRpcCommand(
	socketPath: string,
	command: RpcCommand,
	options: RpcClientOptions = {},
): Promise<{ response: RpcResponse; event?: { message?: ExtractedMessage; turnIndex?: number } }> {
	const { timeout = 5000, waitForEvent } = options;

	return new Promise((resolve, reject) => {
		const socket = net.createConnection(socketPath);
		socket.setEncoding("utf8");

		const timeoutHandle = setTimeout(() => {
			socket.destroy(new Error("RPC timeout"));
		}, timeout);

		let buffer = "";
		let response: RpcResponse | null = null;

		const cleanup = () => {
			clearTimeout(timeoutHandle);
			socket.removeAllListeners();
		};

		socket.on("connect", () => {
			socket.write(`${JSON.stringify(command)}\n`);

			if (waitForEvent === "turn_end") {
				const subscribeCmd: RpcSubscribeCommand = { type: "subscribe", event: "turn_end" };
				socket.write(`${JSON.stringify(subscribeCmd)}\n`);
			}
		});

		socket.on("data", (chunk) => {
			buffer += chunk;
			let newlineIndex = buffer.indexOf("\n");
			while (newlineIndex !== -1) {
				const line = buffer.slice(0, newlineIndex).trim();
				buffer = buffer.slice(newlineIndex + 1);
				newlineIndex = buffer.indexOf("\n");
				if (!line) continue;

				try {
					const msg = JSON.parse(line) as { type: string; command?: string; event?: string; success?: boolean; data?: unknown };

					if (msg.type === "response") {
						if (msg.command === command.type) {
							response = msg as RpcResponse;
							if (!waitForEvent) {
								cleanup();
								socket.end();
								resolve({ response });
								return;
							}
						}
						continue;
					}

					if (msg.type === "event" && msg.event === "turn_end" && waitForEvent === "turn_end") {
						cleanup();
						socket.end();
						if (!response) {
							reject(new Error("Received turn_end event before command response"));
							return;
						}
						resolve({ response, event: (msg.data as { message?: ExtractedMessage; turnIndex?: number }) || {} });
						return;
					}
				} catch {
					// Ignore JSON parse errors on individual lines, keep waiting
				}
			}
		});

		socket.on("error", (error: Error) => {
			cleanup();
			reject(error);
		});
	});
}
