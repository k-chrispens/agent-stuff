import { promises as fs } from "node:fs";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Filesystem, InMemorySnapshotStore, Patch, Patcher, normalizeToLF, stripBom } from "@oh-my-pi/hashline";
import { ensureHashlineRuntime, resolveExistingInside, resolveInside, resolveWritableInside, run, which } from "./lib/omp-lite/common.mjs";
import { detectLspServers, formatLspConfig, formatLspStatus, runDiagnostics } from "./lib/omp-lite/lsp.mjs";
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

class CwdFilesystem extends Filesystem {
  cwd: string;

  constructor(cwd: string) {
    super();
    this.cwd = cwd;
  }

  canonicalPath(inputPath: string): string {
    return resolveInside(this.cwd, inputPath);
  }

  async readText(inputPath: string): Promise<string> {
    return fs.readFile(await resolveExistingInside(this.cwd, inputPath), "utf8");
  }

  async preflightWrite(inputPath: string): Promise<void> {
    await resolveWritableInside(this.cwd, inputPath);
  }

  async atomicWrite(target: string, content: string): Promise<void> {
    await fs.mkdir(path.dirname(target), { recursive: true });
    const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.tmp`);
    await fs.writeFile(tmp, content, "utf8");
    await fs.rename(tmp, target);
  }

  async writeText(inputPath: string, content: string): Promise<{ text: string }> {
    await this.atomicWrite(await resolveWritableInside(this.cwd, inputPath), content);
    return { text: content };
  }

  async delete(inputPath: string): Promise<void> {
    await fs.rm(await resolveExistingInside(this.cwd, inputPath));
  }

  async move(from: string, to: string, content?: string): Promise<void> {
    const fromAbs = await resolveExistingInside(this.cwd, from);
    const toAbs = await resolveWritableInside(this.cwd, to);
    await fs.mkdir(path.dirname(toAbs), { recursive: true });
    if (content === undefined) await fs.rename(fromAbs, toAbs);
    else {
      await this.atomicWrite(toAbs, content);
      await fs.rm(fromAbs);
    }
  }
}

const HashlineReadParams = Type.Object({ path: Type.String({ description: "File path to read and snapshot" }) });
const HashlineEditParams = Type.Object({ input: Type.String({ description: "Hashline patch input" }) });
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

ensureHashlineRuntime();

export default function ompLite(pi: ExtensionAPI): void {
  const snapshots = new InMemorySnapshotStore();

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
      const { text: bomlessText } = stripBom(text);
      const normalized = normalizeToLF(bomlessText);
      const lines = normalized.split("\n");
      const tag = snapshots.record(canonical, normalized, lines.map((_, index) => index + 1));
      return { content: [{ type: "text", text: `[${relative}#${tag}]\n${lines.map((line, index) => `${index + 1}:${line}`).join("\n")}` }], details: { path: relative, tag } };
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
      const text = result.sections
        .map((section) => `${section.header}\n${section.op}${section.firstChangedLine ? ` firstChangedLine=${section.firstChangedLine}` : ""}${section.warnings.length ? `\nWarnings:\n${section.warnings.join("\n")}` : ""}`)
        .join("\n\n");
      return { content: [{ type: "text", text }], details: result };
    },
  });

  pi.registerTool({
    name: "ast_edit",
    label: "AST Edit",
    description: "Preview or apply simple ast-grep structural rewrites. Requires ast-grep/sg on PATH.",
    promptSnippet: "Preview/apply simple ast-grep structural rewrites",
    parameters: AstEditParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (params.ops.length !== 1) return { content: [{ type: "text", text: "Error: MVP ast_edit accepts exactly one op per call." }], details: { success: false } };
      if (params.paths.length === 0) return { content: [{ type: "text", text: "Error: MVP ast_edit accepts at least one path per call." }], details: { success: false } };
      let paths: string[];
      try {
        paths = await Promise.all(params.paths.map((inputPath) => resolveExistingInside(ctx.cwd, inputPath)));
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }], details: { success: false } };
      }
      const bin = await which(["ast-grep", "sg"]);
      if (!bin) return { content: [{ type: "text", text: "Error: ast_edit requires ast-grep (`brew install ast-grep` or install `sg`)." }], details: { success: false } };
      const op = params.ops[0];
      const args = ["run", "--pattern", op.pat, "--rewrite", op.out, ...(params.apply ? ["--update-all"] : []), ...paths];
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
      const lspState = await detectLspServers(ctx.cwd);
      if (params.action === "status") {
        return { content: [{ type: "text", text: formatLspStatus(lspState.servers) }], details: lspState };
      }
      if (params.action === "config") {
        return { content: [{ type: "text", text: formatLspConfig(lspState) }], details: lspState };
      }
      const result = await runDiagnostics(ctx.cwd);
      return { content: [{ type: "text", text: result.text }], details: result.details };
    },
  });
}
