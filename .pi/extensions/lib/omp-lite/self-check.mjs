import assert from "node:assert/strict";
import { domainMatches, normalizeDomain, resolveInside, shellQuote } from "./common.mjs";
import { defaultLspServers, formatLspStatus } from "./lsp.mjs";
import { buildDomainRestrictedQuery, filterSourcesByDomains, DEFAULT_SEARCH_DOMAINS } from "./web-search.mjs";
import { buildSubagentLaunch, normalizeSubagentTasks } from "./subagent.mjs";

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
assert.match(buildSubagentLaunch({ sessionName: "worker-a", cwd: "/tmp/x", assignment: "do it", context: "ctx" }), /\/name worker-a/);
assert.ok(defaultLspServers.some((server) => server.name === "typescript-language-server"));
assert.match(formatLspStatus([{ name: "x", available: false, command: "x", fileTypes: [".x"] }]), /x.*missing/);
assert.throws(() => resolveInside("/repo", "../escape"), /Path escapes cwd/);
assert.throws(() => resolveInside("/repo", "/tmp/escape"), /Path escapes cwd/);

console.log("omp-lite helper self-check passed");
