# OMP Lite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add current-Pi-compatible thin wrappers inspired by oh-my-pi for domain-restricted web search, zmx-backed subagents, hashline edits, AST rewrites, and lightweight LSP checks.

**Architecture:** One project-local Pi extension, `.pi/extensions/omp-lite.ts`, registers the new tools. Small helper modules under `.pi/extensions/lib/omp-lite/` hold pure logic that can be tested without booting Pi. Skills and README teach agents to use the tools instead of old workflows.

**Tech Stack:** TypeScript Pi extension API, `@sinclair/typebox`, Node built-ins, `@oh-my-pi/hashline`, external `zmx`, optional external `ast-grep`/`sg`, existing `pi --session-control` extension.

## Global Constraints

- Keep using the existing `pi` binary and extension APIs from this repo.
- Do not replace the current Pi runtime with oh-my-pi.
- Do not vendor large oh-my-pi core subsystems.
- Phase 1 must add MVP-usable tools for web search, zmx-backed subagents, hashline edits, simple AST rewrites, and lightweight LSP workflows.
- `web_search` must default to a curated domain allowlist and require `unrestricted: true` for broad web search.
- New npm dependencies are allowed, but final debt notes must explain how to remove oh-my-pi dependencies later.
- `subagent` must use zmx; never spawn bare background `pi` processes.
- Mutating tools must avoid partial writes where practical.

---

## File Structure

- Create `.pi/extensions/omp-lite.ts`: Pi extension entry point; imports helpers and registers `web_search`, `subagent`, `hashline_read`, `hashline_edit`, `ast_edit`, and `lsp`.
- Create `.pi/extensions/lib/omp-lite/common.mjs`: shared helpers (`textResult`, `run`, `which`, path/domain utilities, shell quoting).
- Create `.pi/extensions/lib/omp-lite/web-search.mjs`: curated domain allowlist, DuckDuckGo/Exa search helpers, query rewriting, URL post-filtering, and formatting.
- Create `.pi/extensions/lib/omp-lite/subagent.mjs`: zmx session name generation and command construction.
- Create `.pi/extensions/lib/omp-lite/lsp.mjs`: lightweight LSP config loading, executable/root marker detection, and diagnostics command planning.
- Create `.pi/extensions/lib/omp-lite/self-check.mjs`: assertion-based tests for pure helper behavior.
- Modify `.pi/extensions/package.json`: add `@oh-my-pi/hashline` dependency.
- Modify `skills/zmx/SKILL.md`: document `subagent` as preferred first-class worker delegation.
- Modify `skills/native-web-search/SKILL.md`: point agents at `web_search`; keep script as fallback.
- Modify `README.md`: list `omp-lite.ts` and the new tool behavior.

---

### Task 1: Shared Helpers and Dependency Setup

**Files:**
- Create: `.pi/extensions/lib/omp-lite/common.mjs`
- Create: `.pi/extensions/lib/omp-lite/self-check.mjs`
- Modify: `.pi/extensions/package.json`

**Interfaces:**
- Produces: `textResult(text: string, details?: object): { content: [{ type: "text", text: string }], details: object }`
- Produces: `run(command: string, args: string[], options?: { cwd?: string, timeoutMs?: number }): Promise<{ code: number | null, stdout: string, stderr: string }>`
- Produces: `which(names: string[]): Promise<string | null>`
- Produces: `shellQuote(value: string): string`
- Produces: `normalizeDomain(domain: string): string`
- Produces: `domainMatches(hostname: string, domain: string): boolean`
- Produces: self-check script used by later tasks.

- [ ] **Step 1: Add the hashline dependency**

Edit `.pi/extensions/package.json` so `dependencies` contains this additional entry:

```json
"@oh-my-pi/hashline": "^16.3.10"
```

The dependencies object should still include the existing `@mariozechner/*` and `@sinclair/typebox` entries.

- [ ] **Step 2: Install dependencies**

Run:

```bash
cd .pi/extensions && npm install
```

Expected: npm exits `0` and updates `.pi/extensions/package-lock.json`.

- [ ] **Step 3: Create shared helper module**

Create `.pi/extensions/lib/omp-lite/common.mjs` with:

```js
import { spawn } from "node:child_process";
import path from "node:path";

export function textResult(text, details = {}) {
  return { content: [{ type: "text", text }], details };
}

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

export function run(command, args = [], options = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000;
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

export async function which(names) {
  for (const name of names) {
    const result = await run("/usr/bin/env", ["sh", "-lc", `command -v ${shellQuote(name)}`], { timeoutMs: 5000 });
    const found = result.stdout.trim().split(/\r?\n/)[0];
    if (result.code === 0 && found) return found;
  }
  return null;
}

export function normalizeDomain(domain) {
  return String(domain)
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "")
    .replace(/\.+$/, "");
}

export function hostnameFromUrl(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function domainMatches(hostname, domain) {
  const host = normalizeDomain(hostname);
  const needle = normalizeDomain(domain);
  return host === needle || host.endsWith(`.${needle}`);
}

export function resolveInside(cwd, inputPath) {
  const raw = String(inputPath || "").replace(/^@/, "");
  const abs = path.resolve(cwd, raw);
  const rel = path.relative(cwd, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path escapes cwd: ${inputPath}`);
  }
  return abs;
}
```

- [ ] **Step 4: Create self-check script**

Create `.pi/extensions/lib/omp-lite/self-check.mjs` with:

```js
import assert from "node:assert/strict";
import { domainMatches, normalizeDomain, shellQuote } from "./common.mjs";

assert.equal(normalizeDomain("https://www.GitHub.com/foo"), "github.com");
assert.equal(domainMatches("docs.github.com", "github.com"), true);
assert.equal(domainMatches("evilgithub.com", "github.com"), false);
assert.equal(shellQuote("a'b"), `'a'"'"'b'`);

console.log("omp-lite helper self-check passed");
```

- [ ] **Step 5: Run helper self-check**

Run:

```bash
node .pi/extensions/lib/omp-lite/self-check.mjs
```

Expected output includes:

```text
omp-lite helper self-check passed
```

- [ ] **Step 6: Commit Task 1**

```bash
git add .pi/extensions/package.json .pi/extensions/package-lock.json .pi/extensions/lib/omp-lite/common.mjs .pi/extensions/lib/omp-lite/self-check.mjs
git commit -m "feat(omp-lite): add shared extension helpers"
```

---

### Task 2: Domain-Restricted `web_search` Helper and Tool

**Files:**
- Create: `.pi/extensions/lib/omp-lite/web-search.mjs`
- Modify: `.pi/extensions/lib/omp-lite/self-check.mjs`
- Create: `.pi/extensions/omp-lite.ts`

**Interfaces:**
- Consumes: `textResult`, `normalizeDomain`, `domainMatches`, `hostnameFromUrl` from `common.mjs`.
- Produces: `DEFAULT_SEARCH_DOMAINS: string[]`
- Produces: `buildDomainRestrictedQuery(query: string, domains: string[]): string`
- Produces: `searchWeb(params: { query: string, recency?: string, limit?: number, domains?: string[], unrestricted?: boolean, signal?: AbortSignal }): Promise<{ text: string, details: object }>`
- Produces Pi tool `web_search` with params `{ query, recency?, limit?, domains?, unrestricted? }`.

- [ ] **Step 1: Write failing helper assertions**

Append this to `.pi/extensions/lib/omp-lite/self-check.mjs` before the final `console.log`:

```js
import { buildDomainRestrictedQuery, filterSourcesByDomains, DEFAULT_SEARCH_DOMAINS } from "./web-search.mjs";

assert.ok(DEFAULT_SEARCH_DOMAINS.includes("github.com"));
assert.match(buildDomainRestrictedQuery("pi agent", ["github.com", "docs.rs"]), /site:github\.com OR site:docs\.rs/);
assert.deepEqual(
  filterSourcesByDomains([
    { title: "ok", url: "https://docs.github.com/a" },
    { title: "bad", url: "https://example.com/a" },
  ], ["github.com"]),
  [{ title: "ok", url: "https://docs.github.com/a" }],
);
```

Run:

```bash
node .pi/extensions/lib/omp-lite/self-check.mjs
```

Expected: FAIL with module-not-found for `web-search.mjs`.

- [ ] **Step 2: Implement web search helper**

Create `.pi/extensions/lib/omp-lite/web-search.mjs` with:

```js
import { domainMatches, hostnameFromUrl, normalizeDomain } from "./common.mjs";

export const DEFAULT_SEARCH_DOMAINS = [
  "github.com", "gist.github.com", "gitlab.com",
  "developer.mozilla.org", "docs.rs", "readthedocs.io", "readthedocs.org",
  "stackoverflow.com", "stackexchange.com", "superuser.com", "serverfault.com", "askubuntu.com",
  "npmjs.com", "pypi.org", "crates.io", "pkg.go.dev", "hex.pm", "packagist.org", "rubygems.org", "nuget.org", "hub.docker.com",
  "huggingface.co", "ollama.com",
  "arxiv.org", "biorxiv.org", "crossref.org", "semanticscholar.org", "pubmed.ncbi.nlm.nih.gov", "rfc-editor.org", "ietf.org", "w3.org",
  "nvd.nist.gov", "osv.dev", "cisa.gov", "spdx.org",
  "wikipedia.org", "wikidata.org",
  "news.ycombinator.com", "lobste.rs", "reddit.com", "dev.to",
];

export function effectiveDomains(domains, unrestricted) {
  if (unrestricted) return [];
  const list = Array.isArray(domains) && domains.length > 0 ? domains : DEFAULT_SEARCH_DOMAINS;
  return [...new Set(list.map(normalizeDomain).filter(Boolean))];
}

export function buildDomainRestrictedQuery(query, domains) {
  const clean = String(query || "").trim();
  if (!domains.length) return clean;
  return `${clean} (${domains.map((domain) => `site:${domain}`).join(" OR ")})`;
}

export function filterSourcesByDomains(sources, domains) {
  if (!domains.length) return sources;
  return sources.filter((source) => {
    const host = hostnameFromUrl(source.url);
    return domains.some((domain) => domainMatches(host, domain));
  });
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripTags(value) {
  return decodeHtml(String(value || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

export function parseDuckDuckGoHtml(html, limit) {
  const out = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  for (const match of html.matchAll(re)) {
    let url = decodeHtml(match[1]);
    try {
      const parsed = new URL(url, "https://duckduckgo.com");
      const uddg = parsed.searchParams.get("uddg");
      if (uddg) url = uddg;
    } catch {}
    out.push({ title: stripTags(match[2]), url, snippet: stripTags(match[3]) });
    if (out.length >= limit) break;
  }
  return out;
}

export async function searchDuckDuckGo(params) {
  const limit = Math.max(1, Math.min(Number(params.limit || 10), 20));
  const domains = effectiveDomains(params.domains, params.unrestricted);
  const query = buildDomainRestrictedQuery(params.query, domains);
  const body = new URLSearchParams({ q: query, kl: "us-en" });
  if (["day", "week", "month", "year"].includes(params.recency || "")) {
    body.set("df", { day: "d", week: "w", month: "m", year: "y" }[params.recency]);
  }
  const response = await fetch("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "pi-omp-lite/1.0" },
    body,
    signal: params.signal,
  });
  if (!response.ok) throw new Error(`DuckDuckGo search failed: HTTP ${response.status}`);
  const html = await response.text();
  const sources = filterSourcesByDomains(parseDuckDuckGoHtml(html, limit * 3), domains).slice(0, limit);
  return { provider: "duckduckgo", query, domains, sources };
}

export async function searchExa(params) {
  const apiKey = process.env.EXA_API_KEY;
  if (!apiKey) return null;
  const limit = Math.max(1, Math.min(Number(params.limit || 10), 20));
  const domains = effectiveDomains(params.domains, params.unrestricted);
  const response = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({
      query: params.query,
      numResults: limit,
      ...(domains.length ? { includeDomains: domains } : {}),
      contents: { summary: { query: params.query } },
    }),
    signal: params.signal,
  });
  if (!response.ok) throw new Error(`Exa search failed: HTTP ${response.status} ${await response.text()}`);
  const json = await response.json();
  const sources = filterSourcesByDomains((json.results || []).map((item) => ({
    title: item.title || item.url,
    url: item.url,
    snippet: item.summary || item.text,
  })), domains).slice(0, limit);
  return { provider: "exa", query: params.query, domains, sources };
}

export function formatSearchResult(result) {
  if (!result.sources.length) {
    const restricted = result.domains?.length ? ` within allowlisted domains (${result.domains.join(", ")})` : "";
    return `Error: No web search results found${restricted}.`;
  }
  const lines = [];
  if (result.domains?.length) lines.push(`Domain-restricted search over ${result.domains.length} allowlisted domain(s).`);
  lines.push(`Provider: ${result.provider}`);
  for (const [index, source] of result.sources.entries()) {
    lines.push(`[${index + 1}] ${source.title}\n    ${source.url}`);
    if (source.snippet) lines.push(`    ${String(source.snippet).slice(0, 240)}`);
  }
  return lines.join("\n");
}

export async function searchWeb(params) {
  const errors = [];
  for (const fn of [searchExa, searchDuckDuckGo]) {
    try {
      const result = await fn(params);
      if (result) return { text: formatSearchResult(result), details: result };
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { text: `Error: ${errors.join("; ") || "No web search provider configured."}`, details: { errors } };
}
```

- [ ] **Step 3: Run helper self-check**

Run:

```bash
node .pi/extensions/lib/omp-lite/self-check.mjs
```

Expected: PASS and prints `omp-lite helper self-check passed`.

- [ ] **Step 4: Create extension entry point with `web_search` tool**

Create `.pi/extensions/omp-lite.ts` with:

```ts
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { searchWeb } from "./lib/omp-lite/web-search.mjs";

const WebSearchParams = Type.Object({
  query: Type.String({ description: "Search query" }),
  recency: Type.Optional(StringEnum(["day", "week", "month", "year"] as const)),
  limit: Type.Optional(Type.Number({ description: "Maximum results, default 10" })),
  domains: Type.Optional(Type.Array(Type.String({ description: "Domain allowlist override" }))),
  unrestricted: Type.Optional(Type.Boolean({ description: "Disable the default domain allowlist" })),
});

export default function ompLite(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description: "Search the web with a curated technical-domain allowlist by default. Set unrestricted=true for broad web search.",
    promptSnippet: "Search curated technical/reference domains for up-to-date information with source URLs",
    promptGuidelines: [
      "Use web_search for internet research; it is domain-restricted by default and returns source URLs.",
      "Set web_search unrestricted=true only when the curated domain allowlist is too narrow for the user's request.",
    ],
    parameters: WebSearchParams,
    async execute(_toolCallId, params, signal) {
      const result = await searchWeb({ ...params, signal });
      return { content: [{ type: "text", text: result.text }], details: result.details };
    },
  });
}
```

- [ ] **Step 5: Smoke-load the extension**

Run:

```bash
pi --no-extensions -e .pi/extensions/omp-lite.ts --help >/tmp/omp-lite-help.txt
```

Expected: command exits `0`. If Pi prints help to stderr, accept that as long as exit code is `0`.

- [ ] **Step 6: Commit Task 2**

```bash
git add .pi/extensions/omp-lite.ts .pi/extensions/lib/omp-lite/web-search.mjs .pi/extensions/lib/omp-lite/self-check.mjs
git commit -m "feat(omp-lite): add domain restricted web search"
```

---

### Task 3: zmx-Backed `subagent` Tool

**Files:**
- Create: `.pi/extensions/lib/omp-lite/subagent.mjs`
- Modify: `.pi/extensions/lib/omp-lite/self-check.mjs`
- Modify: `.pi/extensions/omp-lite.ts`

**Interfaces:**
- Consumes: `shellQuote`, `which` from `common.mjs`.
- Produces: `normalizeSubagentTasks(params: object): Array<{ id?: string, assignment: string, description?: string }>`
- Produces: `buildSubagentLaunch({ sessionName, cwd, assignment, context }): string`
- Produces Pi tool `subagent` with params `{ assignment?, context?, id?, tasks? }`.

- [ ] **Step 1: Add failing subagent assertions**

Append before the final `console.log` in `.pi/extensions/lib/omp-lite/self-check.mjs`:

```js
import { buildSubagentLaunch, normalizeSubagentTasks } from "./subagent.mjs";

assert.deepEqual(normalizeSubagentTasks({ assignment: "do x" }), [{ assignment: "do x" }]);
assert.equal(normalizeSubagentTasks({ tasks: [{ id: "a", assignment: "do a" }] })[0].id, "a");
assert.match(buildSubagentLaunch({ sessionName: "worker-a", cwd: "/tmp/x", assignment: "do it", context: "ctx" }), /pi --session-control/);
assert.match(buildSubagentLaunch({ sessionName: "worker-a", cwd: "/tmp/x", assignment: "do it", context: "ctx" }), /\/name worker-a/);
```

Run:

```bash
node .pi/extensions/lib/omp-lite/self-check.mjs
```

Expected: FAIL with module-not-found for `subagent.mjs`.

- [ ] **Step 2: Implement subagent helper**

Create `.pi/extensions/lib/omp-lite/subagent.mjs` with:

```js
import { shellQuote } from "./common.mjs";

function slug(value) {
  return String(value || "worker")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "worker";
}

export function normalizeSubagentTasks(params) {
  if (Array.isArray(params.tasks) && params.tasks.length > 0) {
    return params.tasks.map((task) => ({
      id: task.id ? slug(task.id) : undefined,
      description: task.description,
      assignment: String(task.assignment || "").trim(),
    })).filter((task) => task.assignment);
  }
  const assignment = String(params.assignment || "").trim();
  return assignment ? [{ id: params.id ? slug(params.id) : undefined, description: params.description, assignment }] : [];
}

export function makeSessionName(prefix, index, task) {
  const base = task.id || task.description || task.assignment.split(/\s+/).slice(0, 4).join("-");
  return slug(`${prefix || "subagent"}-${index + 1}-${base}`);
}

export function buildSubagentPrompt({ sessionName, assignment, context }) {
  return [
    `You are subagent ${sessionName}.`,
    context ? `Shared context:\n${context}` : "",
    `Assignment:\n${assignment}`,
    "Claim any relevant todo before editing. When done, summarize results and changed files.",
  ].filter(Boolean).join("\n\n");
}

export function buildSubagentLaunch({ sessionName, cwd, assignment, context }) {
  const prompt = buildSubagentPrompt({ sessionName, assignment, context });
  return `cd ${shellQuote(cwd)} && exec pi --session-control ${shellQuote(`/name ${sessionName}`)} ${shellQuote(prompt)}`;
}

export function formatSubagentResult(spawns) {
  return [
    `Spawned ${spawns.length} zmx-backed subagent${spawns.length === 1 ? "" : "s"}.`,
    "",
    ...spawns.map((spawn) => [
      `- ${spawn.sessionName}`,
      `  - history: zmx history ${spawn.sessionName}`,
      `  - attach: zmx attach ${spawn.sessionName}`,
      `  - kill: zmx kill ${spawn.sessionName} --force`,
    ].join("\n")),
  ].join("\n");
}
```

- [ ] **Step 3: Run helper self-check**

Run:

```bash
node .pi/extensions/lib/omp-lite/self-check.mjs
```

Expected: PASS.

- [ ] **Step 4: Register `subagent` tool**

Modify `.pi/extensions/omp-lite.ts`:

Add imports:

```ts
import { normalizeSubagentTasks, makeSessionName, buildSubagentLaunch, formatSubagentResult } from "./lib/omp-lite/subagent.mjs";
```

Add schemas above `export default`:

```ts
const SubagentTask = Type.Object({
  id: Type.Optional(Type.String({ description: "Short stable worker id" })),
  description: Type.Optional(Type.String({ description: "Human label for this task" })),
  assignment: Type.String({ description: "Self-contained assignment" }),
});

const SubagentParams = Type.Object({
  id: Type.Optional(Type.String({ description: "Short stable worker id for single-task mode" })),
  description: Type.Optional(Type.String({ description: "Human label for single-task mode" })),
  assignment: Type.Optional(Type.String({ description: "Single self-contained assignment" })),
  context: Type.Optional(Type.String({ description: "Shared context prepended to every task" })),
  tasks: Type.Optional(Type.Array(SubagentTask, { description: "Batch of independent tasks" })),
});
```

Inside `ompLite(pi)`, after the `web_search` registration, add:

```ts
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: "Spawn one or more first-class worker Pi sessions through zmx. Returns monitoring commands; use send_to_session for follow-up.",
    promptSnippet: "Spawn zmx-backed Pi worker sessions for independent tasks",
    promptGuidelines: [
      "Use subagent for independent worker delegation instead of starting bare background processes.",
      "After subagent returns, inspect workers with zmx history or coordinate with send_to_session once sessions are named.",
    ],
    parameters: SubagentParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const tasks = normalizeSubagentTasks(params).slice(0, 8);
      if (tasks.length === 0) {
        return { content: [{ type: "text", text: "Error: subagent needs assignment or tasks[]." }], details: { spawns: [] } };
      }
      const spawns: Array<{ sessionName: string; command: string }> = [];
      for (let i = 0; i < tasks.length; i++) {
        const task = tasks[i];
        const sessionName = makeSessionName("subagent", i, task);
        const script = buildSubagentLaunch({ sessionName, cwd: ctx.cwd, assignment: task.assignment, context: params.context });
        const result = await pi.exec("zmx", ["run", sessionName, "-d", "sh", "-lc", script], { signal, timeout: 10_000 });
        if (result.code !== 0) {
          return { content: [{ type: "text", text: `Error: failed to spawn ${sessionName}: ${result.stderr || result.stdout}` }], details: { spawns } };
        }
        spawns.push({ sessionName, command: script });
      }
      return { content: [{ type: "text", text: formatSubagentResult(spawns) }], details: { spawns } };
    },
  });
```

- [ ] **Step 5: Smoke-load the extension**

Run:

```bash
pi --no-extensions -e .pi/extensions/omp-lite.ts --help >/tmp/omp-lite-help.txt
```

Expected: exit `0`.

- [ ] **Step 6: Commit Task 3**

```bash
git add .pi/extensions/omp-lite.ts .pi/extensions/lib/omp-lite/subagent.mjs .pi/extensions/lib/omp-lite/self-check.mjs
git commit -m "feat(omp-lite): add zmx subagents"
```

---

### Task 4: Hashline Read/Edit Tools

**Files:**
- Modify: `.pi/extensions/omp-lite.ts`

**Interfaces:**
- Consumes: `@oh-my-pi/hashline` exports `Filesystem`, `InMemorySnapshotStore`, `Patch`, `Patcher`.
- Produces Pi tool `hashline_read` with params `{ path }`, returning `[path#TAG]` plus numbered lines.
- Produces Pi tool `hashline_edit` with params `{ input }`, applying hashline patches using the session-local snapshot store.

- [ ] **Step 1: Add hashline imports and local filesystem adapter**

Modify `.pi/extensions/omp-lite.ts` imports:

```ts
import { promises as fs } from "node:fs";
import path from "node:path";
import { Filesystem, InMemorySnapshotStore, Patch, Patcher } from "@oh-my-pi/hashline";
import { resolveInside } from "./lib/omp-lite/common.mjs";
```

Add above `export default`:

```ts
class CwdFilesystem extends Filesystem {
  constructor(private cwd: string) { super(); }

  canonicalPath(inputPath: string): string {
    return resolveInside(this.cwd, inputPath);
  }

  async readText(inputPath: string): Promise<string> {
    return fs.readFile(this.canonicalPath(inputPath), "utf8");
  }

  async writeText(inputPath: string, content: string): Promise<{ text: string }> {
    const target = this.canonicalPath(inputPath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
    return { text: content };
  }

  async delete(inputPath: string): Promise<void> {
    await fs.rm(this.canonicalPath(inputPath));
  }

  async move(from: string, to: string, content?: string): Promise<void> {
    const fromAbs = this.canonicalPath(from);
    const toAbs = this.canonicalPath(to);
    await fs.mkdir(path.dirname(toAbs), { recursive: true });
    if (content === undefined) await fs.rename(fromAbs, toAbs);
    else {
      await fs.writeFile(toAbs, content, "utf8");
      await fs.rm(fromAbs);
    }
  }
}

const HashlineReadParams = Type.Object({ path: Type.String({ description: "File path to read and snapshot" }) });
const HashlineEditParams = Type.Object({ input: Type.String({ description: "Hashline patch input" }) });
```

- [ ] **Step 2: Register `hashline_read` and `hashline_edit`**

Inside `ompLite(pi)`, before registering tools, add a session-local store:

```ts
  const snapshots = new InMemorySnapshotStore();
```

Then add tool registrations after `subagent`:

```ts
  pi.registerTool({
    name: "hashline_read",
    label: "Hashline Read",
    description: "Read a file and emit a hashline snapshot header usable by hashline_edit.",
    promptSnippet: "Read a file with a [path#TAG] hashline header for hashline_edit",
    parameters: HashlineReadParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const fsAdapter = new CwdFilesystem(ctx.cwd);
      const canonical = fsAdapter.canonicalPath(params.path);
      const text = await fsAdapter.readText(params.path);
      const relative = path.relative(ctx.cwd, canonical).split(path.sep).join("/");
      const tag = snapshots.record(canonical, text);
      const lines = text.split(/\r?\n/).map((line, index) => `${index + 1}:${line}`);
      return { content: [{ type: "text", text: `[${relative}#${tag}]\n${lines.join("\n")}` }], details: { path: relative, tag } };
    },
  });

  pi.registerTool({
    name: "hashline_edit",
    label: "Hashline Edit",
    description: "Apply a hashline patch previously anchored by hashline_read.",
    promptSnippet: "Apply hashline patches using [path#TAG] snapshot anchors",
    parameters: HashlineEditParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const fsAdapter = new CwdFilesystem(ctx.cwd);
      const patch = Patch.parse(params.input, { cwd: ctx.cwd });
      const patcher = new Patcher({ fs: fsAdapter, snapshots });
      const result = await patcher.apply(patch);
      const text = result.sections.map((section) => `${section.header}\n${section.op}${section.firstChangedLine ? ` firstChangedLine=${section.firstChangedLine}` : ""}${section.warnings.length ? `\nWarnings:\n${section.warnings.join("\n")}` : ""}`).join("\n\n");
      return { content: [{ type: "text", text }], details: result };
    },
  });
```

- [ ] **Step 3: Smoke-load the extension**

Run:

```bash
pi --no-extensions -e .pi/extensions/omp-lite.ts --help >/tmp/omp-lite-help.txt
```

Expected: exit `0`. If TypeScript complains about `@oh-my-pi/hashline` types, change the import to a dynamic import inside `hashline_edit` and keep `CwdFilesystem` as a runtime subclass of `hashline.Filesystem`.

- [ ] **Step 4: Test hashline behavior on a temporary file**

Run an interactive manual smoke in Pi or use the tool from a short prompt:

```bash
mkdir -p /tmp/omp-lite-check && printf 'const x = 1;\n' >/tmp/omp-lite-check/a.ts
pi --no-extensions -e "$PWD/.pi/extensions/omp-lite.ts" -p --no-session "Use hashline_read on /tmp/omp-lite-check/a.ts, then use hashline_edit to change line 1 to const x = 2."
cat /tmp/omp-lite-check/a.ts
```

Expected final file content:

```text
const x = 2;
```

- [ ] **Step 5: Commit Task 4**

```bash
git add .pi/extensions/omp-lite.ts
git commit -m "feat(omp-lite): add hashline editing"
```

---

### Task 5: `ast_edit` and Lightweight `lsp` Tools

**Files:**
- Create: `.pi/extensions/lib/omp-lite/lsp.mjs`
- Modify: `.pi/extensions/lib/omp-lite/self-check.mjs`
- Modify: `.pi/extensions/omp-lite.ts`

**Interfaces:**
- Consumes: `run`, `which`, `resolveInside` from `common.mjs`.
- Produces: `detectLspServers(cwd: string): Promise<Array<{ name, command, fileTypes, rootMarkers, available }>>`
- Produces: `planDiagnostics(cwd: string): Promise<{ label: string, command: string, args: string[] } | null>`
- Produces Pi tool `ast_edit` with params `{ paths, ops, apply? }`.
- Produces Pi tool `lsp` with params `{ action, file? }`.

- [ ] **Step 1: Add failing LSP helper assertions**

Append before final `console.log` in `.pi/extensions/lib/omp-lite/self-check.mjs`:

```js
import { defaultLspServers, formatLspStatus } from "./lsp.mjs";

assert.ok(defaultLspServers.some((server) => server.name === "typescript-language-server"));
assert.match(formatLspStatus([{ name: "x", available: false, command: "x", fileTypes: [".x"] }]), /x.*missing/);
```

Run:

```bash
node .pi/extensions/lib/omp-lite/self-check.mjs
```

Expected: FAIL with module-not-found for `lsp.mjs`.

- [ ] **Step 2: Implement LSP helper**

Create `.pi/extensions/lib/omp-lite/lsp.mjs` with:

```js
import { existsSync } from "node:fs";
import path from "node:path";
import { run, which } from "./common.mjs";

export const defaultLspServers = [
  { name: "typescript-language-server", command: "typescript-language-server", fileTypes: [".ts", ".tsx", ".js", ".jsx"], rootMarkers: ["package.json", "tsconfig.json"] },
  { name: "pyright", command: "pyright-langserver", fileTypes: [".py"], rootMarkers: ["pyproject.toml", "setup.py", "requirements.txt"] },
  { name: "gopls", command: "gopls", fileTypes: [".go"], rootMarkers: ["go.mod"] },
  { name: "rust-analyzer", command: "rust-analyzer", fileTypes: [".rs"], rootMarkers: ["Cargo.toml"] },
];

function hasRootMarker(cwd, markers) {
  return markers.some((marker) => existsSync(path.join(cwd, marker)));
}

export async function detectLspServers(cwd) {
  const out = [];
  for (const server of defaultLspServers) {
    const resolved = await which([server.command]);
    out.push({ ...server, available: Boolean(resolved) && hasRootMarker(cwd, server.rootMarkers), resolvedCommand: resolved });
  }
  return out;
}

export function formatLspStatus(servers) {
  if (!servers.length) return "No lightweight LSP servers configured.";
  return servers.map((server) => `${server.name}: ${server.available ? `available (${server.resolvedCommand || server.command})` : `missing or root marker absent (${server.command})`}`).join("\n");
}

export async function planDiagnostics(cwd) {
  if (existsSync(path.join(cwd, "tsconfig.json"))) return { label: "TypeScript", command: "npx", args: ["tsc", "--noEmit"] };
  if (existsSync(path.join(cwd, "Cargo.toml"))) return { label: "Rust", command: "cargo", args: ["check", "--message-format=short"] };
  if (existsSync(path.join(cwd, "go.mod"))) return { label: "Go", command: "go", args: ["test", "./..."] };
  if (existsSync(path.join(cwd, "pyproject.toml"))) return { label: "Python", command: "pyright", args: [] };
  return null;
}

export async function runDiagnostics(cwd) {
  const plan = await planDiagnostics(cwd);
  if (!plan) return { text: "No diagnostics command detected for this project.", details: { success: false } };
  const result = await run(plan.command, plan.args, { cwd, timeoutMs: 60_000 });
  return { text: `${plan.label} diagnostics exited ${result.code}\n${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`, details: { success: result.code === 0, plan, code: result.code } };
}
```

- [ ] **Step 3: Run helper self-check**

Run:

```bash
node .pi/extensions/lib/omp-lite/self-check.mjs
```

Expected: PASS.

- [ ] **Step 4: Register `ast_edit` and `lsp` tools**

Modify `.pi/extensions/omp-lite.ts` imports:

```ts
import { run, which } from "./lib/omp-lite/common.mjs";
import { detectLspServers, formatLspStatus, runDiagnostics } from "./lib/omp-lite/lsp.mjs";
```

Add schemas above `export default`:

```ts
const AstEditParams = Type.Object({
  paths: Type.Array(Type.String({ description: "Files or directories to rewrite" })),
  ops: Type.Array(Type.Object({
    pat: Type.String({ description: "ast-grep pattern" }),
    out: Type.String({ description: "replacement; empty string deletes matches" }),
  })),
  apply: Type.Optional(Type.Boolean({ description: "Apply changes; default false previews command only" })),
});

const LspParams = Type.Object({
  action: StringEnum(["status", "config", "diagnostics"] as const),
  file: Type.Optional(Type.String({ description: "Reserved for future file-scoped LSP actions" })),
});
```

Inside `ompLite(pi)`, add:

```ts
  pi.registerTool({
    name: "ast_edit",
    label: "AST Edit",
    description: "Preview or apply simple ast-grep structural rewrites. Requires ast-grep/sg on PATH.",
    promptSnippet: "Preview/apply simple ast-grep structural rewrites",
    parameters: AstEditParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const bin = await which(["ast-grep", "sg"]);
      if (!bin) return { content: [{ type: "text", text: "Error: ast_edit requires ast-grep (`brew install ast-grep` or install `sg`)." }], details: { success: false } };
      if (params.ops.length !== 1) return { content: [{ type: "text", text: "Error: MVP ast_edit accepts exactly one op per call." }], details: { success: false } };
      const op = params.ops[0];
      const args = ["run", "--pattern", op.pat, "--rewrite", op.out, ...(params.apply ? ["--update-all"] : []), ...params.paths];
      const result = await run(bin, args, { cwd: ctx.cwd, timeoutMs: 60_000 });
      return { content: [{ type: "text", text: `$ ${bin} ${args.join(" ")}\n${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}` }], details: { success: result.code === 0, code: result.code, args } };
    },
  });

  pi.registerTool({
    name: "lsp",
    label: "LSP",
    description: "Lightweight LSP-inspired status/config/diagnostics checks. Does not run a long-lived JSON-RPC LSP client.",
    promptSnippet: "Check lightweight language server status and project diagnostics",
    parameters: LspParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (params.action === "status" || params.action === "config") {
        const servers = await detectLspServers(ctx.cwd);
        return { content: [{ type: "text", text: formatLspStatus(servers) }], details: { servers } };
      }
      const result = await runDiagnostics(ctx.cwd);
      return { content: [{ type: "text", text: result.text }], details: result.details };
    },
  });
```

- [ ] **Step 5: Smoke-load the extension**

Run:

```bash
pi --no-extensions -e .pi/extensions/omp-lite.ts --help >/tmp/omp-lite-help.txt
```

Expected: exit `0`.

- [ ] **Step 6: Commit Task 5**

```bash
git add .pi/extensions/omp-lite.ts .pi/extensions/lib/omp-lite/lsp.mjs .pi/extensions/lib/omp-lite/self-check.mjs
git commit -m "feat(omp-lite): add ast and lsp tools"
```

---

### Task 6: Skills, README, and Final Verification

**Files:**
- Modify: `skills/zmx/SKILL.md`
- Modify: `skills/native-web-search/SKILL.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: tools registered by `.pi/extensions/omp-lite.ts`.
- Produces: documentation that points agents at `web_search`, `subagent`, `hashline_read`, `hashline_edit`, `ast_edit`, and `lsp`.

- [ ] **Step 1: Update zmx skill**

In `skills/zmx/SKILL.md`, replace the first paragraph under `## Subagents and workers` with:

```md
Prefer the `subagent` tool for first-class worker delegation. It starts each worker inside zmx, launches `pi --session-control`, names the session, and returns monitoring commands. Use raw `zmx run ... pi ...` only when you need custom worker startup not covered by `subagent`.
```

Keep the existing manual zmx examples after that paragraph.

- [ ] **Step 2: Update native web search skill**

At the top of `skills/native-web-search/SKILL.md`, after the heading, add:

```md
Prefer the `web_search` tool registered by `.pi/extensions/omp-lite.ts`. It searches a curated technical/reference domain allowlist by default, returns source URLs, and supports `unrestricted: true` when broad web search is necessary. Use `search.mjs` only as a fallback when the tool is unavailable.
```

- [ ] **Step 3: Update README extension list**

In `README.md`, add `.pi/extensions/omp-lite.ts` to the Project-local extensions list:

```md
- [`omp-lite.ts`](.pi/extensions/omp-lite.ts) - current-Pi-compatible thin wrappers inspired by oh-my-pi: domain-restricted `web_search`, zmx `subagent`, `hashline_read`/`hashline_edit`, simple `ast_edit`, and lightweight `lsp`.
```

Also update the `native-web-search` skill bullet to say it is now fallback guidance for the `web_search` tool.

- [ ] **Step 4: Run helper and extension smoke checks**

Run:

```bash
node .pi/extensions/lib/omp-lite/self-check.mjs
pi --no-extensions -e .pi/extensions/omp-lite.ts --help >/tmp/omp-lite-help.txt
```

Expected: both commands exit `0`.

- [ ] **Step 5: Run setup smoke if safe**

Run:

```bash
./setup.sh
```

Expected: exits `0`, installs `.pi/extensions` dependencies, and lists `omp-lite.ts` under settings extensions.

- [ ] **Step 6: Record final debt notes in the final response**

Final response after implementation must include this debt section:

```md
Debt to remove OMP deps later:
- Replace `@oh-my-pi/hashline` with a local subset for `hashline_read`/`hashline_edit` if only basic `SWAP`, `DEL`, and `INS` are needed.
- Keep the OMP-specific import isolated to `.pi/extensions/omp-lite.ts`; move it behind a tiny adapter if more hashline code accumulates.
- Decide whether `ast-grep` remains an external binary or is replaced by simpler language-specific rewrites.
```

- [ ] **Step 7: Commit Task 6**

```bash
git add README.md skills/zmx/SKILL.md skills/native-web-search/SKILL.md
git commit -m "docs(omp-lite): document new tools"
```

---

## Self-Review Notes

- Spec coverage: all phase-1 components are covered: `web_search` (Task 2), `subagent` (Task 3), hashline tools (Task 4), `ast_edit` and `lsp` (Task 5), skills/docs (Task 6), dependency setup (Task 1), and OMP dependency-removal debt (Task 6 final response requirement).
- Placeholder scan: no unresolved placeholder markers or vague "add tests" steps remain; each task has runnable commands and concrete code snippets.
- Type consistency: helper names used in `.pi/extensions/omp-lite.ts` match the interfaces defined in helper tasks.
