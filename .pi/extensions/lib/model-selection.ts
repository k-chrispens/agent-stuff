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
	getApiKey: (model: Model<Api>) => Promise<string | undefined>;
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
		const apiKey = await modelRegistry.getApiKey(codexModel);
		if (apiKey) return codexModel;
	}

	const haikuModel = modelRegistry.find("anthropic", HAIKU_MODEL_ID);
	if (haikuModel) {
		const apiKey = await modelRegistry.getApiKey(haikuModel);
		if (apiKey) return haikuModel;
	}

	return fallback;
}
