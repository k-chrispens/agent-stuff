/**
 * Shared types for the session control extension.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type * as net from "node:net";

// ============================================================================
// RPC Types
// ============================================================================

export interface RpcResponse {
	type: "response";
	command: string;
	success: boolean;
	error?: string;
	data?: unknown;
	id?: string;
}

export interface RpcEvent {
	type: "event";
	event: string;
	data?: unknown;
	subscriptionId?: string;
}

export interface RpcSendCommand {
	type: "send";
	message: string;
	mode?: "steer" | "follow_up";
	id?: string;
}

export interface RpcGetMessageCommand {
	type: "get_message";
	id?: string;
}

export interface RpcGetSummaryCommand {
	type: "get_summary";
	id?: string;
}

export interface RpcClearCommand {
	type: "clear";
	summarize?: boolean;
	id?: string;
}

export interface RpcAbortCommand {
	type: "abort";
	id?: string;
}

export interface RpcSubscribeCommand {
	type: "subscribe";
	event: "turn_end";
	id?: string;
}

export type RpcCommand =
	| RpcSendCommand
	| RpcGetMessageCommand
	| RpcGetSummaryCommand
	| RpcClearCommand
	| RpcAbortCommand
	| RpcSubscribeCommand;

// ============================================================================
// Subscription & State Types
// ============================================================================

export interface TurnEndSubscription {
	socket: net.Socket;
	subscriptionId: string;
}

export interface SocketState {
	server: net.Server | null;
	socketPath: string | null;
	context: ExtensionContext | null;
	alias: string | null;
	aliasTimer: ReturnType<typeof setInterval> | null;
	turnEndSubscriptions: TurnEndSubscription[];
}

// ============================================================================
// Message Types
// ============================================================================

export interface ExtractedMessage {
	role: "user" | "assistant";
	content: string;
	timestamp: number;
}

// ============================================================================
// Live Session Types
// ============================================================================

export interface LiveSessionInfo {
	sessionId: string;
	name?: string;
	aliases: string[];
	socketPath: string;
}

// ============================================================================
// RPC Client Options
// ============================================================================

export interface RpcClientOptions {
	timeout?: number;
	waitForEvent?: "turn_end";
}
