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
