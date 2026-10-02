import { createOpenRouter } from "@openrouter/ai-sdk-provider";

export interface OpenRouterConfig {
  apiKey: string;
  model: string;
}

type EnvLike = Readonly<Record<string, string | undefined>>;

/** Reads the two required OpenRouter values without exposing credential contents in errors. */
export function readOpenRouterConfig(env: EnvLike): OpenRouterConfig {
  const apiKey = env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) throw new Error("Missing OPENROUTER_API_KEY");

  const model = env.OPENROUTER_MODEL?.trim();
  if (!model) throw new Error("Missing OPENROUTER_MODEL");

  return { apiKey, model };
}

/** Constructs the configured language model; network requests happen only when the model is used. */
export function createOpenRouterModel(config: OpenRouterConfig) {
  return createOpenRouter({ apiKey: config.apiKey })(config.model);
}
