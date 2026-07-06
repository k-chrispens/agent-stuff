import { shellQuote } from "./common.mjs";

function slug(value) {
  return String(value || "worker")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "worker";
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
