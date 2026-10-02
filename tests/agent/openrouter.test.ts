import { describe, expect, it } from "vitest";

import { createOpenRouterModel, readOpenRouterConfig } from "../../src/agent/index.js";

describe("OpenRouter configuration", () => {
  it("fails explicitly when the API key is missing", () => {
    expect(() => readOpenRouterConfig({ OPENROUTER_MODEL: "provider/model" })).toThrow("Missing OPENROUTER_API_KEY");
  });

  it("fails for a missing model without exposing the supplied key", () => {
    const sentinelSecret = "sentinel-secret-must-not-appear";
    expect(() => readOpenRouterConfig({ OPENROUTER_API_KEY: sentinelSecret })).toThrow("Missing OPENROUTER_MODEL");
    try {
      readOpenRouterConfig({ OPENROUTER_API_KEY: sentinelSecret });
    } catch (error) {
      expect(String(error)).not.toContain(sentinelSecret);
    }
  });

  it("treats blank required values as missing", () => {
    expect(() => readOpenRouterConfig({ OPENROUTER_API_KEY: "   ", OPENROUTER_MODEL: "provider/model" })).toThrow("Missing OPENROUTER_API_KEY");
    expect(() => readOpenRouterConfig({ OPENROUTER_API_KEY: "key", OPENROUTER_MODEL: "\t" })).toThrow("Missing OPENROUTER_MODEL");
  });

  it("trims valid values and constructs a model without a network request", () => {
    const config = readOpenRouterConfig({
      OPENROUTER_API_KEY: " test-key ",
      OPENROUTER_MODEL: " provider/model ",
    });

    expect(config).toEqual({ apiKey: "test-key", model: "provider/model" });
    expect(createOpenRouterModel(config).modelId).toBe("provider/model");
  });
});
