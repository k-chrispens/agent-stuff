import assert from "node:assert/strict";
import { domainMatches, normalizeDomain, shellQuote } from "./common.mjs";

assert.equal(normalizeDomain("https://www.GitHub.com/foo"), "github.com");
assert.equal(domainMatches("docs.github.com", "github.com"), true);
assert.equal(domainMatches("evilgithub.com", "github.com"), false);
assert.equal(shellQuote("a'b"), `'a'"'"'b'`);

console.log("omp-lite helper self-check passed");
