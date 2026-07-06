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
