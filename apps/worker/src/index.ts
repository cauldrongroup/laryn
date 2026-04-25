import type { CleanupTier, TranscriptionError, TranscriptionResponse } from "@laryn/shared";

export interface Env {
  AI: Ai;
  AI_GATEWAY_ID: string;
  AI_GATEWAY_TRANSCRIPTION_MODEL?: "@cf/deepgram/nova-3";
  AI_GATEWAY_CLEANUP_MODEL?: string;
  AI_GATEWAY_CLEANUP_FALLBACK_MODEL?: string;
  AI_GATEWAY_CLEANUP_PREMIUM_MODEL?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
  CLEANUP_TIER?: CleanupTier;
  LARYN_DESKTOP_TOKEN?: string;
}

type CleanupResult = {
  text: string;
  model?: string;
  applied: boolean;
  fallbackUsed?: boolean;
  warning?: string;
};

const TRANSCRIPTION_MODEL = "@cf/deepgram/nova-3" as const;
const STANDARD_CLEANUP_MODEL = "@cf/qwen/qwen3-30b-a3b-fp8";
const FALLBACK_CLEANUP_MODEL = "@cf/ibm-granite/granite-4.0-h-micro";
const PREMIUM_CLEANUP_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const DEFAULT_CLEANUP_TIER: CleanupTier = "standard";
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const CLEANUP_PROMPT = `You clean up speech-to-text dictation conservatively.

Rules:
- Preserve the speaker's meaning, tone, wording, and level of formality.
- Do not add new ideas, facts, claims, examples, or explanations.
- Do not summarize.
- Do not make the text more polished than the original intent.
- Fix obvious transcription mistakes only when the correction is clear.
- Add punctuation and capitalization.
- Remove repeated filler words only when they are clearly accidental.
- Keep intentional informal phrasing.
- Return only the cleaned text, with no preamble, labels, markdown, or quotes.

Clean this transcript conservatively:

`;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }));
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return json({
        ok: true,
        transcriptionModel: env.AI_GATEWAY_TRANSCRIPTION_MODEL ?? TRANSCRIPTION_MODEL,
        cleanupModel: env.AI_GATEWAY_CLEANUP_MODEL ?? STANDARD_CLEANUP_MODEL,
        cleanupFallbackModel: env.AI_GATEWAY_CLEANUP_FALLBACK_MODEL ?? FALLBACK_CLEANUP_MODEL,
        cleanupPremiumModel: env.AI_GATEWAY_CLEANUP_PREMIUM_MODEL ?? PREMIUM_CLEANUP_MODEL,
        cleanupTier: normalizeCleanupTier(env.CLEANUP_TIER)
      });
    }

    if (request.method === "GET" && url.pathname === "/health/auth") {
      const authError = authorize(request, env, true);
      if (authError) {
        return authError;
      }

      return json({
        ok: true,
        auth: "ok",
        transcriptionModel: env.AI_GATEWAY_TRANSCRIPTION_MODEL ?? TRANSCRIPTION_MODEL,
        cleanupTier: normalizeCleanupTier(env.CLEANUP_TIER)
      });
    }

    if (request.method !== "POST" || url.pathname !== "/v1/transcriptions") {
      return json<TranscriptionError>({ error: "Not found" }, 404);
    }

    const authError = authorize(request, env, true);
    if (authError) {
      return authError;
    }

    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.includes("multipart/form-data")) {
      return json<TranscriptionError>({ error: "Expected multipart/form-data" }, 415);
    }

    const form = await request.formData();
    const audio = form.get("audio");
    if (!(audio instanceof File)) {
      return json<TranscriptionError>({ error: "Missing audio file field" }, 400);
    }

    if (audio.size === 0) {
      return json<TranscriptionError>({ error: "Audio file is empty" }, 400);
    }

    if (audio.size > MAX_AUDIO_BYTES) {
      return json<TranscriptionError>({ error: "Audio file is too large", detail: "Limit is 25 MB" }, 413);
    }

    const started = Date.now();
    const cleanupTier = normalizeCleanupTier(String(form.get("cleanupTier") ?? env.CLEANUP_TIER ?? DEFAULT_CLEANUP_TIER));
    const transcriptionModel = env.AI_GATEWAY_TRANSCRIPTION_MODEL ?? TRANSCRIPTION_MODEL;
    const transcriptionPayload = await runTranscription(audio, env, transcriptionModel);
    const rawText = extractTranscriptText(transcriptionPayload);

    if (!rawText) {
      return json<TranscriptionResponse>({
        id: crypto.randomUUID(),
        text: "",
        rawText: "",
        cleanedText: "",
        pastedVariant: "raw",
        cleanupApplied: false,
        cleanupTier,
        cleanupWarning: "No speech detected.",
        wordCount: 0,
        durationMs: Date.now() - started,
        transcriptionModel
      });
    }

    const cleanup = await cleanupTranscript(rawText, cleanupTier, env);
    const text = cleanup.applied ? cleanup.text : rawText;

    return json<TranscriptionResponse>({
      id: crypto.randomUUID(),
      text,
      rawText,
      cleanedText: cleanup.applied ? cleanup.text : rawText,
      pastedVariant: cleanup.applied ? "cleaned" : "raw",
      cleanupApplied: cleanup.applied,
      cleanupTier,
      cleanupWarning: cleanup.warning,
      fallbackUsed: cleanup.fallbackUsed,
      wordCount: countWords(text),
      durationMs: Date.now() - started,
      transcriptionModel,
      cleanupModel: cleanup.model
    });
  }
};

async function runTranscription(audio: File, env: Env, model: typeof TRANSCRIPTION_MODEL): Promise<unknown> {
  try {
    return await env.AI.run(
      model,
      {
        audio: {
          body: audio.stream(),
          contentType: audio.type || "audio/webm"
        },
        detect_language: true,
        punctuate: true,
        smart_format: true,
        numerals: true
      },
      {
        gateway: { id: env.AI_GATEWAY_ID }
      }
    );
  } catch (error) {
    if (!canUseRestFallback(env)) {
      throw error;
    }

    return runTranscriptionRestFallback(audio, env, model);
  }
}

async function cleanupTranscript(rawText: string, tier: CleanupTier, env: Env): Promise<CleanupResult> {
  const models = cleanupModelsForTier(tier, env);
  const failures: string[] = [];

  for (let index = 0; index < models.length; index += 1) {
    const model = models[index];
    try {
      const payload = await runCleanupModel(rawText, env, model);
      const cleanedText = extractGeneratedText(payload);
      const validationError = validateCleanup(rawText, cleanedText);
      if (validationError) {
        failures.push(`${model}: ${validationError}`);
        continue;
      }

      return {
        text: cleanedText,
        model,
        applied: true,
        fallbackUsed: index > 0
      };
    } catch (error) {
      failures.push(`${model}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    text: rawText,
    model: models.at(-1),
    applied: false,
    fallbackUsed: models.length > 1,
    warning: `Cleanup unavailable; pasted raw transcript. ${failures.join(" | ")}`
  };
}

async function runCleanupModel(rawText: string, env: Env, model: string): Promise<unknown> {
  const payload = {
    prompt: `${CLEANUP_PROMPT}${rawText}`,
    temperature: 0.1,
    top_p: 0.8,
    max_tokens: 2048
  };

  try {
    return await env.AI.run(model, payload, {
      gateway: { id: env.AI_GATEWAY_ID }
    });
  } catch (error) {
    if (!canUseRestFallback(env)) {
      throw error;
    }

    return runJsonRestFallback(env, model, payload);
  }
}

async function runTranscriptionRestFallback(audio: File, env: Env, model: string): Promise<unknown> {
  const url = new URL(workerAiRunUrl(env, model));
  url.searchParams.set("detect_language", "true");
  url.searchParams.set("punctuate", "true");
  url.searchParams.set("smart_format", "true");
  url.searchParams.set("numerals", "true");

  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
      "content-type": audio.type || "audio/webm"
    },
    body: await audio.arrayBuffer()
  });

  return readCloudflareAiResponse(response);
}

async function runJsonRestFallback(env: Env, model: string, payload: unknown): Promise<unknown> {
  const response = await fetch(workerAiRunUrl(env, model), {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  return readCloudflareAiResponse(response);
}

async function readCloudflareAiResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }

  if (!response.ok) {
    throw new Error(typeof payload === "object" ? JSON.stringify(payload) : String(payload));
  }

  if (isRecord(payload) && "result" in payload) {
    return payload.result;
  }

  return payload;
}

function workerAiRunUrl(env: Env, model: string): string {
  return `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai/run/${model}`;
}

function canUseRestFallback(env: Env): env is Env & { CLOUDFLARE_ACCOUNT_ID: string; CLOUDFLARE_API_TOKEN: string } {
  return Boolean(env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN);
}

function cleanupModelsForTier(tier: CleanupTier, env: Env): string[] {
  const standard = env.AI_GATEWAY_CLEANUP_MODEL ?? STANDARD_CLEANUP_MODEL;
  const fallback = env.AI_GATEWAY_CLEANUP_FALLBACK_MODEL ?? FALLBACK_CLEANUP_MODEL;
  const premium = env.AI_GATEWAY_CLEANUP_PREMIUM_MODEL ?? PREMIUM_CLEANUP_MODEL;

  if (tier === "cheap") {
    return [fallback];
  }

  if (tier === "premium") {
    return [premium, standard, fallback];
  }

  return [standard, fallback];
}

function validateCleanup(rawText: string, cleanedText: string): string | null {
  const trimmed = cleanedText.trim();
  if (!trimmed) {
    return "cleanup returned empty text";
  }

  if (trimmed.length > Math.ceil(rawText.trim().length * 1.25)) {
    return "cleanup expanded the transcript by more than 25%";
  }

  return null;
}

function extractTranscriptText(payload: unknown): string {
  const candidates = [
    getPath(payload, ["results", "channels", 0, "alternatives", 0, "transcript"]),
    getPath(payload, ["channel", "alternatives", 0, "transcript"]),
    getPath(payload, ["result", "text"]),
    getPath(payload, ["text"]),
    getPath(payload, ["transcript"])
  ];

  return firstString(candidates);
}

function extractGeneratedText(payload: unknown): string {
  const candidates = [
    getPath(payload, ["response"]),
    getPath(payload, ["result", "response"]),
    getPath(payload, ["result", "text"]),
    getPath(payload, ["text"]),
    getPath(payload, ["choices", 0, "message", "content"])
  ];

  return stripModelWrapping(firstString(candidates));
}

function getPath(value: unknown, path: Array<string | number>): unknown {
  let current = value;
  for (const part of path) {
    if (typeof part === "number") {
      if (!Array.isArray(current)) {
        return undefined;
      }
      current = current[part];
      continue;
    }

    if (!isRecord(current)) {
      return undefined;
    }
    current = current[part];
  }

  return current;
}

function firstString(values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return "";
}

function stripModelWrapping(text: string): string {
  return text
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/^cleaned transcript:\s*/i, "")
    .trim();
}

function authorize(request: Request, env: Env, requireConfiguredToken = false): Response | null {
  if (requireConfiguredToken && !env.LARYN_DESKTOP_TOKEN) {
    return json<TranscriptionError>({ error: "Unauthorized", detail: "Worker desktop token is not configured" }, 401);
  }

  if (!env.LARYN_DESKTOP_TOKEN) {
    return null;
  }

  const expected = `Bearer ${env.LARYN_DESKTOP_TOKEN}`;
  if (request.headers.get("authorization") === expected) {
    return null;
  }

  return json<TranscriptionError>({ error: "Unauthorized" }, 401);
}

function normalizeCleanupTier(value: string | undefined): CleanupTier {
  if (value === "cheap" || value === "premium" || value === "standard") {
    return value;
  }

  return DEFAULT_CLEANUP_TIER;
}

function countWords(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function json<T>(body: T, status = 200): Response {
  return withCors(Response.json(body, { status }));
}

function withCors(response: Response): Response {
  response.headers.set("access-control-allow-origin", "*");
  response.headers.set("access-control-allow-methods", "GET,POST,OPTIONS");
  response.headers.set("access-control-allow-headers", "authorization,content-type");
  return response;
}
