/**
 * Shared model selection utility.
 *
 * Provides a common pattern for choosing a cheap/fast model for auxiliary LLM
 * tasks (question extraction, summarization, etc.). Prefers Codex mini, then
 * Haiku, then falls back to the caller-supplied model.
 */

import type { Model, Api } from "@mariozechner/pi-ai";

export const CODEX_MODEL_ID = "gpt-5.3-codex-spark";
export const HAIKU_MODEL_ID = "claude-haiku-4-5";

export interface ModelRegistry {
	find: (provider: string, modelId: string) => Model<Api> | undefined;
	getApiKeyAndHeaders: (model: Model<Api>) => Promise<{ ok: true; apiKey?: string; headers?: Record<string, string> } | { ok: false; error: string }>;
}

/**
 * Select a small/cheap model for auxiliary tasks.
 *
 * Priority: Codex mini → Haiku → fallback (usually the current session model).
 * Returns undefined only when no model has a usable API key.
 */
export async function selectSmallModel(
	fallback: Model<Api> | undefined,
	modelRegistry: ModelRegistry,
): Promise<Model<Api> | undefined> {
	const codexModel = modelRegistry.find("openai-codex", CODEX_MODEL_ID);
	if (codexModel) {
		const auth = await modelRegistry.getApiKeyAndHeaders(codexModel);
		if (auth.ok) return codexModel;
	}

	const haikuModel = modelRegistry.find("anthropic", HAIKU_MODEL_ID);
	if (haikuModel) {
		const auth = await modelRegistry.getApiKeyAndHeaders(haikuModel);
		if (auth.ok) return haikuModel;
	}

	return fallback;
}
