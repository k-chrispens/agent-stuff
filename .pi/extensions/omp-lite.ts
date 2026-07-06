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
