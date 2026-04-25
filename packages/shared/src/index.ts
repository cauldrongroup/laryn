export type CleanupTier = "cheap" | "standard" | "premium";

export type TranscriptionRequestMeta = {
  mimeType: string;
  durationMs?: number;
  cleanupTier?: CleanupTier;
};

export type TranscriptionResponse = {
  text: string;
  id: string;
  rawText: string;
  cleanedText: string;
  pastedVariant: "cleaned" | "raw";
  cleanupApplied: boolean;
  cleanupTier: CleanupTier;
  cleanupWarning?: string;
  fallbackUsed?: boolean;
  wordCount: number;
  durationMs: number;
  transcriptionModel: "@cf/deepgram/nova-3";
  cleanupModel?: string;
};

export type TranscriptionError = {
  error: string;
  detail?: string;
};
