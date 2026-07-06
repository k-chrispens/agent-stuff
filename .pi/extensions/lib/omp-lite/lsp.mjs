import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { run, which } from "./common.mjs";

export const defaultLspServers = [
  { name: "typescript-language-server", command: "typescript-language-server", fileTypes: [".ts", ".tsx", ".js", ".jsx"], rootMarkers: ["package.json", "tsconfig.json"] },
  { name: "pyright", command: "pyright-langserver", fileTypes: [".py"], rootMarkers: ["pyproject.toml", "setup.py", "requirements.txt"] },
  { name: "gopls", command: "gopls", fileTypes: [".go"], rootMarkers: ["go.mod"] },
  { name: "rust-analyzer", command: "rust-analyzer", fileTypes: [".rs"], rootMarkers: ["Cargo.toml"] },
];

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasRootMarker(cwd, markers = []) {
  return markers.length === 0 || markers.some((marker) => existsSync(path.join(cwd, marker)));
}

function configCandidates(cwd, homeDir) {
  return [
    path.join(homeDir, ".omp", "agent", "lsp.json"),
    path.join(cwd, "lsp.json"),
    path.join(cwd, ".lsp.json"),
    path.join(cwd, ".omp", "lsp.json"),
    path.join(cwd, ".claude", "lsp.json"),
  ];
}

function normalizeOverride(name, override) {
  if (override === false) return { name, disabled: true };
  if (typeof override === "string") return { name, command: override };
  if (!isPlainObject(override)) return null;
  return { ...override, name };
}

function serverOverridesFromConfig(config) {
  if (!isPlainObject(config)) return [];
  const source = isPlainObject(config.servers) ? config.servers : config;
  return Object.entries(source)
    .map(([name, override]) => normalizeOverride(name, override))
    .filter(Boolean);
}

export function loadLspConfig(cwd, options = {}) {
  const homeDir = options.homeDir ?? os.homedir();
  const merged = new Map(defaultLspServers.map((server) => [server.name, { ...server }]));
  const configFiles = [];

  for (const file of configCandidates(cwd, homeDir)) {
    if (!existsSync(file)) continue;
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    configFiles.push(file);
    for (const override of serverOverridesFromConfig(parsed)) {
      const current = merged.get(override.name) ?? { name: override.name };
      merged.set(override.name, { ...current, ...override, name: override.name });
    }
  }

  return {
    configFiles,
    servers: [...merged.values()].filter((server) => server.disabled !== true),
  };
}

export async function detectLspServers(cwd, options = {}) {
  const config = loadLspConfig(cwd, options);
  const servers = [];
  for (const server of config.servers) {
    const resolved = server.command ? await which([server.command]) : null;
    servers.push({
      ...server,
      available: Boolean(resolved) && hasRootMarker(cwd, server.rootMarkers),
      resolvedCommand: resolved,
    });
  }
  return { configFiles: config.configFiles, servers };
}

export function formatLspStatus(servers) {
  if (!servers.length) return "No lightweight LSP servers configured.";
  return servers.map((server) => `${server.name}: ${server.available ? `available (${server.resolvedCommand || server.command})` : `missing or root marker absent (${server.command})`}`).join("\n");
}

export function formatLspConfig(config) {
  const files = config.configFiles.length
    ? config.configFiles.map((file) => `- ${file}`)
    : ["- none (using defaults)"];
  return [
    "Loaded config files:",
    ...files,
    "",
    "Effective servers:",
    formatLspStatus(config.servers),
  ].join("\n");
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
