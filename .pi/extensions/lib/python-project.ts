/**
 * Shared Python project detection utilities.
 *
 * Used by python.ts to choose the appropriate command shims.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Detect whether `cwd` is a pixi-managed Python project.
 *
 * Checks for pixi.toml, pixi.lock, or [tool.pixi] in pyproject.toml.
 */
export function isPixiProject(cwd: string): boolean {
	if (existsSync(join(cwd, "pixi.toml"))) return true;
	if (existsSync(join(cwd, "pixi.lock"))) return true;

	const pyproject = join(cwd, "pyproject.toml");
	if (existsSync(pyproject)) {
		try {
			const content = readFileSync(pyproject, "utf-8");
			if (content.includes("[tool.pixi")) return true;
		} catch (error: unknown) {
			// pyproject.toml exists but can't be read — skip pixi detection.
			const message = error instanceof Error ? error.message : String(error);
			process.stderr.write(`[pixi-detect] Failed to read ${pyproject}: ${message}\n`);
		}
	}

	return false;
}

/**
 * Detect whether `cwd` is a uv-managed Python project.
 *
 * Returns false for pixi projects, even when Pixi interception is disabled.
 * Checks for uv.lock, .python-version, or pyproject.toml.
 */
export function isUvProject(cwd: string): boolean {
	if (isPixiProject(cwd)) return false;

	if (existsSync(join(cwd, "uv.lock"))) return true;
	if (existsSync(join(cwd, ".python-version"))) return true;
	if (existsSync(join(cwd, "pyproject.toml"))) return true;

	return false;
}
