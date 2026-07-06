import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { createJiti } from "@mariozechner/jiti";
import {
  domainMatches,
  ensureHashlineRuntime,
  normalizeDomain,
  resolveExistingInside,
  resolveInside,
  resolveWritableInside,
  shellQuote,
} from "./common.mjs";
import { defaultLspServers, formatLspConfig, formatLspStatus, loadLspConfig } from "./lsp.mjs";
import { buildDomainRestrictedQuery, filterSourcesByDomains, DEFAULT_SEARCH_DOMAINS } from "./web-search.mjs";
import { buildSubagentLaunch, makeSessionName, normalizeSubagentTasks } from "./subagent.mjs";

ensureHashlineRuntime();
const jiti = createJiti(import.meta.url);
const { InMemoryFilesystem, InMemorySnapshotStore, Patch, Patcher } = jiti("@oh-my-pi/hashline");

assert.equal(normalizeDomain("https://www.GitHub.com/foo"), "github.com");
assert.equal(domainMatches("docs.github.com", "github.com"), true);
assert.equal(domainMatches("evilgithub.com", "github.com"), false);
assert.equal(shellQuote("a'b"), `'a'"'"'b'`);
assert.ok(DEFAULT_SEARCH_DOMAINS.includes("github.com"));
assert.match(buildDomainRestrictedQuery("pi agent", ["github.com", "docs.rs"]), /site:github\.com OR site:docs\.rs/);
assert.deepEqual(
  filterSourcesByDomains([
    { title: "ok", url: "https://docs.github.com/a" },
    { title: "bad", url: "https://example.com/a" },
  ], ["github.com"]),
  [{ title: "ok", url: "https://docs.github.com/a" }],
);

assert.deepEqual(normalizeSubagentTasks({ assignment: "do x" }), [{ assignment: "do x" }]);
assert.equal(normalizeSubagentTasks({ tasks: [{ id: "a", assignment: "do a" }] })[0].id, "a");
assert.match(buildSubagentLaunch({ sessionName: "worker-a", cwd: "/tmp/x", assignment: "do it", context: "ctx" }), /pi --session-control/);
assert.match(buildSubagentLaunch({ sessionName: "worker-a", cwd: "/tmp/x", assignment: "do it", context: "ctx" }), /--name 'worker-a'/);
assert.equal(makeSessionName("subagent", 0, { assignment: "do it" }, { suffix: "fixed" }), "subagent-1-do-it-fixed");
assert.notEqual(makeSessionName("subagent", 0, { assignment: "do it" }), makeSessionName("subagent", 0, { assignment: "do it" }));
assert.ok(defaultLspServers.some((server) => server.name === "typescript-language-server"));
assert.match(formatLspStatus([{ name: "x", available: false, command: "x", fileTypes: [".x"] }]), /x.*missing/);
assert.throws(() => resolveInside("/repo", "../escape"), /Path escapes cwd/);
assert.throws(() => resolveInside("/repo", "/tmp/escape"), /Path escapes cwd/);

const lspTmp = await mkdtemp(path.join(os.tmpdir(), "omp-lite-lsp-"));
try {
  const homeDir = path.join(lspTmp, "home");
  const projectDir = path.join(lspTmp, "repo");
  await mkdir(path.join(homeDir, ".omp", "agent"), { recursive: true });
  await mkdir(path.join(projectDir, ".omp"), { recursive: true });
  await writeFile(
    path.join(homeDir, ".omp", "agent", "lsp.json"),
    JSON.stringify({
      servers: {
        "typescript-language-server": { fileTypes: [".mts"] },
        pyright: { disabled: true },
      },
    }),
  );
  await writeFile(
    path.join(projectDir, ".omp", "lsp.json"),
    JSON.stringify({
      "typescript-language-server": { command: "tsserver-custom", rootMarkers: ["package.json"] },
      "custom-lsp": { command: "custom-lsp", fileTypes: [".txt"], rootMarkers: ["custom.root"] },
    }),
  );
  const lspConfig = loadLspConfig(projectDir, { homeDir });
  assert.deepEqual(lspConfig.configFiles, [
    path.join(homeDir, ".omp", "agent", "lsp.json"),
    path.join(projectDir, ".omp", "lsp.json"),
  ]);
  const tsServer = lspConfig.servers.find((server) => server.name === "typescript-language-server");
  assert.equal(tsServer.command, "tsserver-custom");
  assert.deepEqual(tsServer.fileTypes, [".mts"]);
  assert.deepEqual(tsServer.rootMarkers, ["package.json"]);
  assert.equal(lspConfig.servers.some((server) => server.name === "pyright"), false);
  assert.equal(lspConfig.servers.some((server) => server.name === "custom-lsp"), true);
  assert.match(formatLspConfig(lspConfig), /Loaded config files:/);
  assert.match(formatLspConfig(lspConfig), /custom-lsp/);
} finally {
  await rm(lspTmp, { recursive: true, force: true });
}

const symlinkTmp = await mkdtemp(path.join(os.tmpdir(), "omp-lite-symlink-"));
try {
  const repoDir = path.join(symlinkTmp, "repo");
  const outsideDir = path.join(symlinkTmp, "outside");
  await mkdir(repoDir, { recursive: true });
  await mkdir(outsideDir, { recursive: true });
  await writeFile(path.join(outsideDir, "secret.txt"), "secret\n");
  try {
    await symlink(outsideDir, path.join(repoDir, "escape"));
    await assert.rejects(resolveExistingInside(repoDir, "escape/secret.txt"), /Path escapes cwd/);
    await assert.rejects(resolveWritableInside(repoDir, "escape/new.txt"), /Path escapes cwd/);
  } catch (error) {
    if (!error || !["EPERM", "ENOSYS", "EACCES"].includes(error.code)) throw error;
  }
} finally {
  await rm(symlinkTmp, { recursive: true, force: true });
}

const memFs = new InMemoryFilesystem();
const snapshots = new InMemorySnapshotStore();
const before = 'const greeting = "hi";\n';
await memFs.writeText("hello.ts", before);
const tag = snapshots.record("hello.ts", before);
const patcher = new Patcher({ fs: memFs, snapshots });
const patch = Patch.parse(`[hello.ts#${tag}]\nSWAP 1.=1:\n+const greeting = "hello";`);
await patcher.apply(patch);
assert.equal(await memFs.readText("hello.ts"), 'const greeting = "hello";\n');

console.log("omp-lite helper self-check passed");
