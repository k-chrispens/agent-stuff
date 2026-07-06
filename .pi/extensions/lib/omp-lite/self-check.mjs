import assert from "node:assert/strict";
import { domainMatches, normalizeDomain, shellQuote } from "./common.mjs";
import { buildDomainRestrictedQuery, filterSourcesByDomains, DEFAULT_SEARCH_DOMAINS } from "./web-search.mjs";

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

console.log("omp-lite helper self-check passed");
