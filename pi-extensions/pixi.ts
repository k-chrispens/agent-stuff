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
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createBashTool } from "@mariozechner/pi-coding-agent";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { existsSync, readFileSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const interceptedCommandsPath = join(__dirname, "..", "pixi-intercepted-commands");

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

export default function (pi: ExtensionAPI) {
  const cwd = process.cwd();

  if (!isPixiProject(cwd)) return;

  const bashTool = createBashTool(cwd, {
    commandPrefix: `export PATH="${interceptedCommandsPath}:$PATH"`,
  });

  pi.on("session_start", (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.notify("Pixi interceptor loaded", "info");
  });

  pi.registerTool(bashTool);
}
