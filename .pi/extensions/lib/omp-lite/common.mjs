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
