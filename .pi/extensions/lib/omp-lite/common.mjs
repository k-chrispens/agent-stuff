import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath as fsRealpath } from "node:fs/promises";
import path from "node:path";

export function textResult(text, details = {}) {
  return { content: [{ type: "text", text }], details };
}

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

export function ensureHashlineRuntime() {
  const runtime = globalThis.Bun || {};
  if (runtime.hash?.xxHash32) return;
  runtime.hash = {
    ...(runtime.hash || {}),
    xxHash32(value, seed = 0) {
      const hash = createHash("sha256");
      hash.update(String(seed));
      if (typeof value === "string") hash.update(value);
      else hash.update(Buffer.from(value));
      return hash.digest().readUInt32LE(0);
    },
  };
  globalThis.Bun = runtime;
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

function assertInside(basePath, resolvedPath, inputPath) {
  const rel = path.relative(basePath, resolvedPath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path escapes cwd via symlink: ${inputPath}`);
  }
}

async function realpathIfExists(target) {
  try {
    return await fsRealpath(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function resolveExistingInside(cwd, inputPath) {
  const abs = resolveInside(cwd, inputPath);
  const [cwdReal, resolved] = await Promise.all([fsRealpath(cwd), fsRealpath(abs)]);
  assertInside(cwdReal, resolved, inputPath);
  return abs;
}

export async function resolveWritableInside(cwd, inputPath) {
  const abs = resolveInside(cwd, inputPath);
  const cwdReal = await fsRealpath(cwd);
  let probe = abs;
  while (true) {
    const resolved = await realpathIfExists(probe);
    if (resolved) {
      assertInside(cwdReal, resolved, inputPath);
      return abs;
    }
    const parent = path.dirname(probe);
    if (parent === probe) {
      throw new Error(`Path not found: ${inputPath}`);
    }
    probe = parent;
  }
}
