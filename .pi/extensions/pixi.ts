/**
 * Pixi Extension - Redirects Python tooling to pixi equivalents
 *
 * Detects pixi projects (pixi.toml or pyproject.toml with [tool.pixi]) and
 * intercepts common Python tooling commands, redirecting agents to use pixi.
 *
 * Intercepted commands:
 * - pip/pip3: Blocked with suggestions to use `pixi add --pypi`
 * - conda/mamba: Blocked with suggestions to use `pixi add`
 * - poetry: Blocked with pixi equivalents
 * - python/python3: Redirected to `pixi run python`, with blocking for
 *   `python -m pip` and `python -m venv`
 *
 * Only activates when a pixi.toml or pixi-configured pyproject.toml is found
 * in the working directory. Falls through to default bash otherwise.
 *
 * Use `--no-pixi` flag to disable the interceptor.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createBashTool } from "@mariozechner/pi-coding-agent";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isPixiProject } from "./lib/python-project.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const interceptedCommandsPath = join(__dirname, "..", "pixi-intercepted-commands");

const FLAG_NAME = "no-pixi";
const STATUS_KEY = "pixi";

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();

	if (!isPixiProject(cwd)) return;

	pi.registerFlag(FLAG_NAME, {
		description: "Disable pixi command interceptor for this session",
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
			ctx.ui.notify("Pixi interceptor loaded (--no-pixi to disable)", "info");
			ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", "pixi"));
		}
	});

	// Only register the tool override when enabled. When disabled, the
	// built-in bash tool remains untouched.
	if (isEnabled()) {
		pi.registerTool(bashTool);
	}
}
