import { describe, expect, it } from "vitest";
import {
  calculateCleanupUsageCost,
  calculateTotalBillableUnits,
  calculateTranscriptionUsageCost,
  cleanupInputText,
  estimateTokens,
  normalizeDictionaryPayload
} from "./index";

describe("usage billing calculations", () => {
  it("prices Whisper audio minutes in micro-USD units", () => {
    expect(calculateTranscriptionUsageCost(60_000)).toBe(510);
    expect(calculateTranscriptionUsageCost(600_000)).toBe(5_100);
  });

  it("uses the configured Whisper micro-USD rate", () => {
    expect(calculateTranscriptionUsageCost(60_000, { LARYN_WHISPER_MICRO_USD_PER_AUDIO_MINUTE: "500" })).toBe(500);
  });

  it("estimates tokens deterministically", () => {
    expect(estimateTokens("1234")).toBe(1);
    expect(estimateTokens("12345")).toBe(2);
  });

  it("prices cleanup with model-specific input and output token rates", () => {
    const cost = calculateCleanupUsageCost(
      "@cf/meta/llama-3.2-3b-instruct",
      "a".repeat(4_000),
      "b".repeat(2_000)
    );

    expect(cost.inputTokens).toBe(1_000);
    expect(cost.outputTokens).toBe(500);
    expect(cost.estimatedTokens).toBe(true);
    expect(cost.costMicroUsd).toBe(219);
  });

  it("uses provider token usage when present", () => {
    const cost = calculateCleanupUsageCost("@cf/meta/llama-3.2-1b-instruct", "ignored", "ignored", {
      usage: {
        input_tokens: 10_000,
        output_tokens: 5_000
      }
    });

    expect(cost.inputTokens).toBe(10_000);
    expect(cost.outputTokens).toBe(5_000);
    expect(cost.estimatedTokens).toBe(false);
    expect(cost.costMicroUsd).toBe(1_275);
  });

  it("prices Gemma 4 premium cleanup", () => {
    const cost = calculateCleanupUsageCost("@cf/google/gemma-4-26b-a4b-it", "ignored", "ignored", {
      usage: {
        input_tokens: 10_000,
        output_tokens: 5_000
      }
    });

    expect(cost.inputTokens).toBe(10_000);
    expect(cost.outputTokens).toBe(5_000);
    expect(cost.estimatedTokens).toBe(false);
    expect(cost.costMicroUsd).toBe(2_500);
  });

  it("does not add cleanup cost for unpriced or skipped cleanup models", () => {
    const cost = calculateCleanupUsageCost("none", "input", "output");
    expect(cost.costMicroUsd).toBe(0);
  });

  it("rounds total billable usage up and treats three dollars as three million units", () => {
    expect(calculateTotalBillableUnits(509.1, 0.2)).toBe(510);
    expect(3 * 1_000_000).toBe(3_000_000);
  });
});

describe("dictionary normalization and cleanup prompt input", () => {
  it("accepts valid vocabulary and replacement entries", () => {
    const normalized = normalizeDictionaryPayload(
      JSON.stringify({
        version: 1,
        entries: [
          { kind: "vocabulary", phrase: " Laryn ", enabled: true, updatedAt: "2026-01-02T00:00:00Z" },
          { kind: "replacement", phrase: "a pie", replacement: "API", enabled: true, updatedAt: "2026-01-01T00:00:00Z" }
        ]
      })
    );

    expect(normalized.warning).toBeUndefined();
    expect(normalized.entries).toEqual([
      { kind: "vocabulary", phrase: "Laryn" },
      { kind: "replacement", phrase: "a pie", replacement: "API" }
    ]);
  });

  it("drops empty, duplicate, disabled, and malformed entries", () => {
    const normalized = normalizeDictionaryPayload(
      JSON.stringify({
        entries: [
          { kind: "vocabulary", phrase: "Laryn", enabled: true },
          { kind: "vocabulary", phrase: "laryn", enabled: true },
          { kind: "replacement", phrase: "same", replacement: "same", enabled: true },
          { kind: "replacement", phrase: "Cooper Netties", replacement: "Kubernetes", enabled: false },
          { kind: "vocabulary", phrase: "   ", enabled: true },
          null
        ]
      })
    );

    expect(normalized.entries).toEqual([{ kind: "vocabulary", phrase: "Laryn" }]);
  });

  it("caps enabled entries at 200 and returns a warning", () => {
    const normalized = normalizeDictionaryPayload(
      JSON.stringify({
        entries: Array.from({ length: 205 }, (_, index) => ({
          kind: "vocabulary",
          phrase: `Term ${index}`,
          enabled: true,
          updatedAt: new Date(2026, 0, index + 1).toISOString()
        }))
      })
    );

    expect(normalized.entries).toHaveLength(200);
    expect(normalized.warning).toBe("Dictionary truncated to 200 enabled entries.");
  });

  it("includes escaped dictionary XML when entries exist", () => {
    const input = cleanupInputText("call the a pie endpoint", [
      { kind: "vocabulary", phrase: "Laryn & Friends" },
      { kind: "replacement", phrase: "a pie", replacement: "API" }
    ]);

    expect(input).toContain("<dictionary>");
    expect(input).toContain("- Laryn &amp; Friends");
    expect(input).toContain('"a pie" => "API"');
    expect(input).toContain("<transcript>");
  });

  it("omits dictionary XML when no entries exist", () => {
    expect(cleanupInputText("plain transcript", [])).not.toContain("<dictionary>");
  });

  it("includes dictionary text in usage estimates", () => {
    const withoutDictionary = cleanupInputText("plain transcript", []);
    const withDictionary = cleanupInputText("plain transcript", [{ kind: "replacement", phrase: "a pie", replacement: "API" }]);

    expect(estimateTokens(withDictionary)).toBeGreaterThan(estimateTokens(withoutDictionary));
  });
});
