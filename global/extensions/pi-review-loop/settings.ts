import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");
export const LOCAL_PROMPTS_DIR = join(__dirname, "prompts");

export const DEFAULT_MAX_ITERATIONS = 7;
export type ReviewInterruptBehavior = "pause" | "stop";
export const DEFAULT_INTERRUPT_BEHAVIOR: ReviewInterruptBehavior = "pause";

export const DEFAULT_REVIEW_PROMPT = `Great, now I want you to carefully read over all of the new code you just wrote and other existing code with "fresh eyes," looking super carefully for any obvious bugs, errors, problems, issues, confusion, etc. Also, if you notice any pre-existing issues/bugs those should be addressed.

Question everything: Does each line of code need to exist? Unused parameters, dead code, and unnecessary complexity should be removed, not dressed up with underscore prefixes or comments.

This codebase will outlive you. Every shortcut becomes someone else's burden. Every hack compounds into technical debt that slows the whole team down.

You are not just writing code. You are shaping the future of this project. The patterns you establish will be copied. The corners you cut will be cut again.

Fight entropy. Leave the codebase better than you found it.

You MUST read all relevant code and think deeply (ultrathink!!!) first before you make any edits.

**Response format:**
- If you find ANY issues: fix them, then list what you fixed. Do NOT say "no issues found" - instead end with "Fixed [N] issue(s). Ready for another review."
- If you find ZERO issues: describe what you examined and verified, then conclude with "No issues found."

Do not rush to a verdict. Read all relevant code first, trace through edge cases, and only then decide. I am pushing you to do a genuinely thorough review and not just lazily rubber-stamp it. Make sure you think deeply, then ultrathink some more.`;

export const DEFAULT_TRIGGER_PATTERNS: RegExp[] = [
  /\bimplement\s+(the\s+)?plan\b/i,
  /\bimplement\s+(the\s+)?spec\b/i,
  /\bimplement\s+(this\s+)?plan\b/i,
  /\bimplement\s+(this\s+)?spec\b/i,
  /\bstart\s+implementing\b.*\b(plan|spec)\b/i,
  /\bgo\s+ahead\s+and\s+implement\b.*\b(plan|spec)\b/i,
  /\blet'?s\s+implement\b.*\b(plan|spec)\b/i,
  /\b(plan|spec)\b.*\bstart\s+implementing\b/i,
  /\b(plan|spec)\b.*\bgo\s+ahead\s+and\s+implement\b/i,
  /\b(plan|spec)\b.*\blet'?s\s+implement\b/i,
  /read over all of the new code.*fresh eyes/i,
];

export const DEFAULT_EXIT_PATTERNS: RegExp[] = [
  /no\s+(\w+\s+)?issues\s+found/i,
  /no\s+(\w+\s+)?bugs\s+found/i,
  /(?:^|\n)\s*(?:looks\s+good|all\s+good)[\s.,!]*(?:$|\n)/im,
];

export const DEFAULT_ISSUES_FIXED_PATTERNS: RegExp[] = [
  /issues?\s+(i\s+)?fixed/i,
  /fixed\s+(the\s+)?(following|these|this|issues?|bugs?)/i,
  /fixed\s+\d+\s+issues?/i,
  /found\s+and\s+(fixed|corrected|resolved)/i,
  /bugs?\s+(i\s+)?fixed/i,
  /corrected\s+(the\s+)?(following|these|this)/i,
  /(?<!no\s)issues?\s+(i\s+)?(found|identified|discovered)/i,
  /(?<!no\s)problems?\s+(i\s+)?(found|identified|discovered)/i,
  /changes?\s+(i\s+)?made/i,
  /here'?s?\s+what\s+(i\s+)?(fixed|changed|corrected)/i,
  /(issues|bugs|problems|changes|fixes)\s*:/i,
  /ready\s+for\s+(another|the\s+next)\s+review/i,
];

export interface PatternConfig {
  mode?: "extend" | "replace";
  patterns: string[];
}

export interface ReviewPromptConfig {
  type: "inline" | "file" | "template";
  value: string;
}

export interface ReviewerLoopSettingsRaw {
  maxIterations?: number;
  reviewPrompt?: string;
  autoTrigger?: boolean;
  freshContext?: boolean;
  interruptBehavior?: ReviewInterruptBehavior;
  triggerPatterns?: PatternConfig;
  exitPatterns?: PatternConfig;
  issuesFixedPatterns?: PatternConfig;
}

export interface ReviewerLoopSettings {
  maxIterations: number;
  reviewPromptConfig: ReviewPromptConfig;
  autoTrigger: boolean;
  freshContext: boolean;
  interruptBehavior: ReviewInterruptBehavior;
  triggerPatterns: RegExp[];
  exitPatterns: RegExp[];
  issuesFixedPatterns: RegExp[];
}

function parsePattern(input: unknown): RegExp | null {
  if (typeof input !== "string") return null;

  const match = input.match(/^\/(.+)\/([gimsuy]*)$/);
  if (match) {
    try {
      const flags = match[2].replace(/g/g, "");
      return new RegExp(match[1], flags);
    } catch {
      return null;
    }
  }
  const escaped = input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(escaped, "i");
}

function loadPatterns(config: PatternConfig | undefined, defaults: RegExp[]): RegExp[] {
  if (!config?.patterns || !Array.isArray(config.patterns) || config.patterns.length === 0) {
    return defaults;
  }

  const userPatterns = config.patterns
    .map(parsePattern)
    .filter((pattern): pattern is RegExp => pattern !== null);

  if (config.mode === "replace") {
    return userPatterns.length > 0 ? userPatterns : defaults;
  }

  return [...defaults, ...userPatterns];
}

function isFilePath(value: string): boolean {
  return (
    value.startsWith("~/") ||
    value.startsWith("/") ||
    value.startsWith("./") ||
    value.endsWith(".md") ||
    value.endsWith(".txt")
  );
}

function parseReviewPromptConfig(value: string | undefined): ReviewPromptConfig {
  if (!value) {
    return { type: "inline", value: DEFAULT_REVIEW_PROMPT };
  }

  if (value.startsWith("template:")) {
    return { type: "template", value: value.slice("template:".length).trim() };
  }

  if (isFilePath(value)) {
    return { type: "file", value };
  }

  return { type: "inline", value };
}

function stripFrontmatter(content: string): string {
  const match = content.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n)?([\s\S]*)$/);
  return match ? match[1].trim() : content.trim();
}

function resolvePath(value: string): string {
  if (value.startsWith("~/")) {
    return join(homedir(), value.slice(2));
  }
  return value;
}

function parseInterruptBehavior(value: unknown): ReviewInterruptBehavior {
  return value === "stop" ? "stop" : DEFAULT_INTERRUPT_BEHAVIOR;
}

function getTemplateCandidatePaths(name: string): string[] {
  return [
    join(homedir(), ".pi", "agent", "prompts", `${name}.md`),
    join(LOCAL_PROMPTS_DIR, `${name}.md`),
  ];
}

export function getReviewPrompt(config: ReviewPromptConfig): string {
  switch (config.type) {
    case "inline":
      return config.value || DEFAULT_REVIEW_PROMPT;

    case "file": {
      const resolvedPath = resolvePath(config.value);
      try {
        const content = readFileSync(resolvedPath, "utf-8").trim();
        return content || DEFAULT_REVIEW_PROMPT;
      } catch {
        return DEFAULT_REVIEW_PROMPT;
      }
    }

    case "template": {
      for (const templatePath of getTemplateCandidatePaths(config.value)) {
        try {
          if (!existsSync(templatePath)) continue;
          let content = readFileSync(templatePath, "utf-8");
          content = stripFrontmatter(content);
          content = content.replace(/\$@/g, "").trim();
          if (content) return content;
        } catch {
          // Try next candidate
        }
      }
      return DEFAULT_REVIEW_PROMPT;
    }
  }
}

export function loadSettings(): ReviewerLoopSettings {
  let raw: ReviewerLoopSettingsRaw = {};

  try {
    const content = readFileSync(SETTINGS_PATH, "utf-8");
    const parsed = JSON.parse(content);
    raw = parsed?.reviewerLoop ?? {};
  } catch {
    // Use defaults
  }

  return {
    maxIterations:
      typeof raw.maxIterations === "number" && raw.maxIterations >= 1
        ? raw.maxIterations
        : DEFAULT_MAX_ITERATIONS,
    reviewPromptConfig: parseReviewPromptConfig(raw.reviewPrompt),
    autoTrigger: raw.autoTrigger === true,
    freshContext: raw.freshContext === true,
    interruptBehavior: parseInterruptBehavior(raw.interruptBehavior),
    triggerPatterns: loadPatterns(raw.triggerPatterns, DEFAULT_TRIGGER_PATTERNS),
    exitPatterns: loadPatterns(raw.exitPatterns, DEFAULT_EXIT_PATTERNS),
    issuesFixedPatterns: loadPatterns(raw.issuesFixedPatterns, DEFAULT_ISSUES_FIXED_PATTERNS),
  };
}
