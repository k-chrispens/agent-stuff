/**
 * Pixi Extension - Runtime Python interceptor routing.
 *
 * This extension always registers a `bash` override and decides at execution time
 * whether to route through pixi/uv intercept shims or plain bash.
 *
 * Routing precedence:
 * 1) pixi interception (if pixi extension is enabled and project matches)
 * 2) uv interception (if uv extension is enabled and project matches)
 * 3) plain bash
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { createBashTool } from "@mariozechner/pi-coding-agent";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isPixiProject, isUvProject } from "./lib/python-project.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const uvInterceptedCommandsPath = join(__dirname, "..", "intercepted-commands");
const pixiInterceptedCommandsPath = join(__dirname, "..", "pixi-intercepted-commands");

const FLAG_NAME = "no-pixi";
const STATUS_KEY = "pixi";

type InterceptorMode = "none" | "uv" | "pixi";

type SharedInterceptorState = {
	runtimeMarker?: unknown;
	isUvEnabled?: () => boolean;
	isPixiEnabled?: () => boolean;
};

type GlobalWithPythonState = typeof globalThis & {
	__piPythonInterceptorState__?: SharedInterceptorState;
};

function getSharedState(runtimeMarker: unknown): SharedInterceptorState {
	const globalState = globalThis as GlobalWithPythonState;
	const existing = globalState.__piPythonInterceptorState__;
	if (!existing || existing.runtimeMarker !== runtimeMarker) {
		const next: SharedInterceptorState = { runtimeMarker };
		globalState.__piPythonInterceptorState__ = next;
		return next;
	}
	return existing;
}

function resolveInterceptorMode(cwd: string, sharedState: SharedInterceptorState): InterceptorMode {
	const pixiEnabled = sharedState.isPixiEnabled?.() === true;
	if (pixiEnabled && isPixiProject(cwd)) return "pixi";

	const uvEnabled = sharedState.isUvEnabled?.() === true;
	if (uvEnabled && isUvProject(cwd)) return "uv";

	return "none";
}

function updateStatus(ctx: ExtensionContext, mode: InterceptorMode): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(STATUS_KEY, mode === "pixi" ? ctx.ui.theme.fg("dim", "pixi") : undefined);
}

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();
	const sharedState = getSharedState(pi.events);

	pi.registerFlag(FLAG_NAME, {
		description: "Disable pixi command interceptor for this session",
		type: "boolean",
		default: false,
	});

	sharedState.isPixiEnabled = () => pi.getFlag(FLAG_NAME) !== true;

	const plainBash = createBashTool(cwd);
	const uvBash = createBashTool(cwd, {
		commandPrefix: `export PATH="${uvInterceptedCommandsPath}:$PATH"`,
	});
	const pixiBash = createBashTool(cwd, {
		commandPrefix: `export PATH="${pixiInterceptedCommandsPath}:$PATH"`,
	});

	pi.on("session_start", (_event, ctx) => {
		const mode = resolveInterceptorMode(cwd, sharedState);
		updateStatus(ctx, mode);
		if (mode === "pixi" && ctx.hasUI) {
			ctx.ui.notify("Pixi interceptor active (--no-pixi to disable)", "info");
		}
	});

	pi.on("session_switch", (_event, ctx) => {
		updateStatus(ctx, resolveInterceptorMode(cwd, sharedState));
	});

	pi.registerTool({
		...plainBash,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const mode = resolveInterceptorMode(cwd, sharedState);
			if (ctx) {
				updateStatus(ctx, mode);
			}
			const selectedBash = mode === "pixi" ? pixiBash : mode === "uv" ? uvBash : plainBash;
			return selectedBash.execute(toolCallId, params, signal, onUpdate);
		},
	});
}
