/**
 * UV Extension - Redirects Python tooling to uv equivalents
 *
 * Detects uv projects (uv.lock, or pyproject.toml without pixi) and
 * intercepts common Python tooling commands, redirecting agents to use uv.
 *
 * Intercepted commands:
 * - pip/pip3: Blocked with suggestions to use `uv add` or `uv run --with`
 * - poetry: Blocked with uv equivalents (uv init, uv add, uv sync, uv run)
 * - python/python3: Redirected to `uv run python`, with special handling to
 *   block `python -m pip` and `python -m venv`
 *
 * Only activates when a uv project indicator is found in the working directory
 * and the project is not a pixi project (pixi.ts handles those).
 * Falls through to default bash otherwise.
 *
 * The shim scripts are located in the intercepted-commands directory and
 * provide helpful error messages with the equivalent uv commands.
 *
 * Use `--no-uv` flag to disable the interceptor.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createBashTool } from "@mariozechner/pi-coding-agent";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isUvProject } from "./lib/python-project.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const interceptedCommandsPath = join(__dirname, "..", "intercepted-commands");

const FLAG_NAME = "no-uv";
const STATUS_KEY = "uv";

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();

	if (!isUvProject(cwd)) return;

	pi.registerFlag(FLAG_NAME, {
		description: "Disable uv command interceptor for this session",
		type: "boolean",
		default: false,
	});

	const bashTool = createBashTool(cwd, {
		commandPrefix: `export PATH="${interceptedCommandsPath}:$PATH"`,
	});

	const isEnabled = () => pi.getFlag(FLAG_NAME) !== true;

	pi.on("session_start", (_event, ctx) => {
		if (!isEnabled()) return;
		if (ctx.hasUI) {
			ctx.ui.notify("UV interceptor loaded (--no-uv to disable)", "info");
			ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", "uv"));
		}
	});

	// Only register the tool override when enabled. When disabled, the
	// built-in bash tool remains untouched.
	if (isEnabled()) {
		pi.registerTool(bashTool);
	}
}
