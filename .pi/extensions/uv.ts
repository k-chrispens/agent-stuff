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
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createBashTool } from "@mariozechner/pi-coding-agent";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { existsSync, readFileSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const interceptedCommandsPath = join(__dirname, "..", "intercepted-commands");

function isPixiProject(cwd: string): boolean {
  if (existsSync(join(cwd, "pixi.toml"))) return true;
  if (existsSync(join(cwd, "pixi.lock"))) return true;

  const pyproject = join(cwd, "pyproject.toml");
  if (existsSync(pyproject)) {
    try {
      const content = readFileSync(pyproject, "utf-8");
      if (content.includes("[tool.pixi")) return true;
    } catch {}
  }

  return false;
}

function isUvProject(cwd: string): boolean {
  // Skip if this is a pixi project (pixi.ts handles those)
  if (isPixiProject(cwd)) return false;

  if (existsSync(join(cwd, "uv.lock"))) return true;
  if (existsSync(join(cwd, ".python-version"))) return true;
  if (existsSync(join(cwd, "pyproject.toml"))) return true;

  return false;
}

export default function (pi: ExtensionAPI) {
  const cwd = process.cwd();

  if (!isUvProject(cwd)) return;

  const bashTool = createBashTool(cwd, {
    commandPrefix: `export PATH="${interceptedCommandsPath}:$PATH"`,
  });

  pi.on("session_start", (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.notify("UV interceptor loaded", "info");
  });

  pi.registerTool(bashTool);
}
