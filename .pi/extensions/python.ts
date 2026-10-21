/** One bash override for Python workflows; Pixi takes precedence over uv. */
import { createBashToolDefinition, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isPixiProject, isUvProject } from "./lib/python-project.ts";

const extensionDir = dirname(fileURLToPath(import.meta.url));
type InterceptorMode = "none" | "uv" | "pixi";

function updateStatus(ctx: ExtensionContext, mode: InterceptorMode): void {
	if (!ctx.hasUI) return;
	for (const name of ["uv", "pixi"] as const) {
		ctx.ui.setStatus(name, mode === name ? ctx.ui.theme.fg("dim", name) : undefined);
	}
}

export default function (pi: ExtensionAPI) {
	for (const name of ["uv", "pixi"] as const) {
		pi.registerFlag(`no-${name}`, {
			description: `Disable ${name} command interceptor for this session`,
			type: "boolean",
			default: false,
		});
	}

	function resolveMode(cwd: string): InterceptorMode {
		if (pi.getFlag("no-pixi") !== true && isPixiProject(cwd)) return "pixi";
		if (pi.getFlag("no-uv") !== true && isUvProject(cwd)) return "uv";
		return "none";
	}

	const bash = createBashToolDefinition(process.cwd(), {
		spawnHook(context) {
			const mode = resolveMode(context.cwd);
			if (mode === "none") return context;
			const shims = join(extensionDir, "..", mode === "pixi" ? "pixi-intercepted-commands" : "intercepted-commands");
			return { ...context, env: { ...context.env, PATH: `${shims}:${context.env.PATH ?? ""}` } };
		},
	});

	pi.on("session_start", (_event, ctx) => {
		const mode = resolveMode(ctx.cwd);
		updateStatus(ctx, mode);
		if (mode !== "none" && ctx.hasUI) {
			ctx.ui.notify(`${mode === "uv" ? "UV" : "Pixi"} interceptor active (--no-${mode} to disable)`, "info");
		}
	});

	pi.registerTool({
		...bash,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			updateStatus(ctx, resolveMode(ctx.cwd));
			return bash.execute(toolCallId, params, signal, onUpdate, ctx);
		},
	});
}
