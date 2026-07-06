import { randomBytes } from "node:crypto";
import { shellQuote } from "./common.mjs";

function slug(value, maxLength = 40) {
  return String(value || "worker")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength) || "worker";
}

function sessionSuffix() {
  return randomBytes(3).toString("hex");
}

function withOptionalFields(task, assignment) {
  const out = { assignment };
  if (task?.id) out.id = slug(task.id);
  if (task?.description != null) out.description = task.description;
  return out;
}

export function normalizeSubagentTasks(params = {}) {
  if (Array.isArray(params.tasks) && params.tasks.length > 0) {
    return params.tasks
      .map((task) => {
        const current = task || {};
        const assignment = String(current.assignment || "").trim();
        return assignment ? withOptionalFields(current, assignment) : null;
      })
      .filter(Boolean);
  }

  const assignment = String(params.assignment || "").trim();
  return assignment ? [withOptionalFields(params, assignment)] : [];
}

export function makeSessionName(prefix, index, task, options = {}) {
  const head = slug(`${prefix || "subagent"}-${index + 1}`, 20);
  const suffix = slug(options.suffix || sessionSuffix(), 8);
  const source = task.id || task.description || task.assignment.split(/\s+/).slice(0, 4).join("-");
  const maxBaseLength = Math.max(1, 40 - head.length - suffix.length - 2);
  const base = slug(source, maxBaseLength);
  return `${head}-${base}-${suffix}`;
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
