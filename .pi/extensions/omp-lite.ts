import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { buildSubagentLaunch, formatSubagentResult, makeSessionName, normalizeSubagentTasks } from "./lib/omp-lite/subagent.mjs";
import { searchWeb } from "./lib/omp-lite/web-search.mjs";

const WebSearchParams = Type.Object({
  query: Type.String({ description: "Search query" }),
  recency: Type.Optional(StringEnum(["day", "week", "month", "year"] as const)),
  limit: Type.Optional(Type.Number({ description: "Maximum results, default 10" })),
  domains: Type.Optional(Type.Array(Type.String({ description: "Domain allowlist override" }))),
  unrestricted: Type.Optional(Type.Boolean({ description: "Disable the default domain allowlist" })),
});

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
}
