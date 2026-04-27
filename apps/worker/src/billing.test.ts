import { describe, expect, it } from "vitest";
import { calculateCleanupUsageCost, calculateTotalBillableUnits, calculateTranscriptionUsageCost, estimateTokens } from "./index";

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
