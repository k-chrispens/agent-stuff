// PI_SDK_PATH=/path/to/pi-coding-agent/dist/index.js node --test tests/python-routing.test.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const { DefaultResourceLoader, SessionManager, SettingsManager } = await import(process.env.PI_SDK_PATH ?? "@earendil-works/pi-coding-agent");
const extensionPath = fileURLToPath(new URL("../.pi/extensions/python.ts", import.meta.url));
const shimRoot = fileURLToPath(new URL("../.pi/", import.meta.url));

test("one Python bash override routes by context cwd, honors flags, and survives reload", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "agent-stuff-python-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	for (const project of ["plain", "uv", "pixi", "mixed"]) mkdirSync(join(root, project));
	writeFileSync(join(root, "uv/pyproject.toml"), "[project]\nname = 'test'\n");
	writeFileSync(join(root, "pixi/pixi.toml"), "");
	writeFileSync(join(root, "mixed/pixi.toml"), "");
	writeFileSync(join(root, "mixed/uv.lock"), "");
	const loader = new DefaultResourceLoader({
		cwd: root, agentDir: join(root, "agent"), settingsManager: SettingsManager.inMemory(),
		noExtensions: true, additionalExtensionPaths: [extensionPath],
		noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
	});
	for (let pass = 0; pass < 2; pass++) {
		await loader.reload();
		const loaded = loader.getExtensions();
		assert.deepEqual(loaded.errors, []);
		assert.equal(loaded.extensions.length, 1);
		const extension = loaded.extensions[0];
		assert.deepEqual([...extension.tools.keys()], ["bash"]);
		assert.deepEqual([...extension.flags.keys()].sort(), ["no-pixi", "no-uv"]);
		const bash = extension.tools.get("bash").definition;
		for (const [project, noUv, noPixi, mode] of [
			["plain", false, false, "none"],
			["uv", false, false, "uv"],
			["pixi", false, false, "pixi"],
			["mixed", false, false, "pixi"],
			["uv", true, false, "none"],
			["pixi", false, true, "none"],
			["mixed", false, true, "none"],
			["pixi", true, false, "pixi"],
			["uv", false, true, "uv"],
			["mixed", true, true, "none"],
		]) {
			loaded.runtime.flagValues.set("no-uv", noUv);
			loaded.runtime.flagValues.set("no-pixi", noPixi);
			const cwd = join(root, project);
			const sessionManager = SessionManager.inMemory(cwd);
			const result = await bash.execute("test", {
				command: "printf '%s\\n' \"${PATH%%:*}\" \"$PWD\" \"$PI_SESSION_ID\"", timeout: 5,
			}, undefined, undefined, { cwd, hasUI: false, sessionManager });
			const [pathHead, actualCwd, sessionId] = result.content[0].text.trim().split("\n");
			assert.equal(realpathSync(actualCwd), realpathSync(cwd));
			assert.equal(sessionId, sessionManager.getSessionId());
			if (mode === "none") {
				assert.notEqual(pathHead, join(shimRoot, "intercepted-commands"));
				assert.notEqual(pathHead, join(shimRoot, "pixi-intercepted-commands"));
			} else {
				assert.equal(pathHead, join(shimRoot, mode === "pixi" ? "pixi-intercepted-commands" : "intercepted-commands"));
			}
		}
	}
});
