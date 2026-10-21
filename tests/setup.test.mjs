import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

const ponytail = "git:github.com/DietrichGebert/ponytail";
const ponytailSkills = ["ponytail", "ponytail-audit", "ponytail-debt", "ponytail-gain", "ponytail-help", "ponytail-review"];

for (const shared of [true, false]) {
	test(`setup preserves backups and is idempotent (shared Ponytail: ${shared})`, (t) => {
		const root = mkdtempSync(join(tmpdir(), "agent-stuff-setup-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		const repo = join(root, "repo with spaces");
		const home = join(root, "home");
		const bin = join(root, "bin");
		const put = (path, content) => {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, content);
		};
		mkdirSync(repo);
		mkdirSync(bin);
		cpSync(new URL("../setup.sh", import.meta.url), join(repo, "setup.sh"));
		put(join(repo, "skills/smartedit/SKILL.md"), "repo skill");
		put(join(repo, "global/CLAUDE.md"), "repo instructions");
		mkdirSync(join(repo, "global/extensions"));
		put(join(repo, ".pi/extensions/package.json"), "{}");
		put(join(repo, ".pi/extensions/pdf-reader/package.json"), "{}");
		// Prevent network access and dependency installation in the fixture.
		put(join(bin, "git"), "#!/bin/sh\nexit 1\n");
		put(join(bin, "npm"), "#!/bin/sh\nexit 0\n");
		execFileSync("chmod", ["+x", join(bin, "git"), join(bin, "npm")]);
		for (const client of [".agents", ".claude"]) {
			put(join(home, client, "skills/smartedit/SKILL.md"), `${client} original`);
			put(join(home, client, "skills/smartedit.bak/SKILL.md"), `${client} legacy backup`);
		}
		if (shared) {
			for (const name of ponytailSkills) {
				const source = join(home, ".claude/plugins/marketplaces/ponytail/skills", name);
				put(join(source, "SKILL.md"), name);
				symlinkSync(source, join(home, ".agents/skills", name));
			}
		}
		const settingsPath = join(home, ".pi/agent/settings.json");
		const foreign = `${repo}-other/extension.ts`;
		const disabled = `-${repo}/.pi/extensions/notify.ts`;
		put(settingsPath, JSON.stringify({
			defaultModel: "keep-me",
			extensions: [join(repo, ".pi/extensions/uv.ts"), join(repo, ".pi/extensions/pixi.ts"), foreign, disabled],
			packages: [shared ? ponytail : { source: ponytail, skills: ["skills/*"] }, { source: "npm:pi-review-loop" }, "npm:other"],
		}));
		const env = { ...process.env, HOME: home, XDG_STATE_HOME: join(home, "state"), PATH: `${bin}:${process.env.PATH}` };
		const run = () => execFileSync("bash", [join(repo, "setup.sh")], { env, encoding: "utf8", timeout: 15000 });
		run();
		const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
		assert.equal(settings.defaultModel, "keep-me");
		assert.deepEqual(settings.extensions, [disabled, join(repo, ".pi/extensions"), foreign].sort());
		assert.deepEqual(settings.packages, [
			{ source: ponytail, skills: shared ? [] : ["skills/*"] }, "npm:other", "npm:@deevus/pi-zmx",
		]);
		assert.equal(readlinkSync(join(home, ".pi/agent/skills")), join(repo, "skills"));
		for (const client of [".agents", ".claude"]) {
			assert.equal(readlinkSync(join(home, client, "skills/smartedit")), join(repo, "skills/smartedit"));
			assert.equal(existsSync(join(home, client, "skills/smartedit.bak")), false);
		}
		const backupRoot = join(home, "state/agent-stuff/backups");
		const backups = readdirSync(backupRoot).map(dir => {
			const path = join(backupRoot, dir);
			return readFileSync(join(path, readdirSync(path)[0], "SKILL.md"), "utf8");
		}).sort();
		assert.deepEqual(backups, [".agents original", ".agents legacy backup", ".claude original", ".claude legacy backup"].sort());
		run();
		assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), settings);
		assert.equal(readdirSync(backupRoot).length, 4);
	});
}
