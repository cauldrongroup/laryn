import type { DesktopStatus } from "../preload/preload";
import type { CleanupTier, TranscriptionResponse } from "@laryn/shared";

declare global {
  interface Window {
    laryn: {
      ready: () => Promise<DesktopStatus>;
      checkWorker: () => Promise<DesktopStatus>;
      recordingStarted: () => void;
      recordingStopped: () => void;
      transcribeAudio: (audio: ArrayBuffer, mimeType: string, durationMs: number, cleanupTier: CleanupTier) => Promise<TranscriptionResponse>;
      onStartRecording: (callback: () => void) => void;
      onStopRecording: (callback: () => void) => void;
      onStatus: (callback: (status: DesktopStatus) => void) => void;
    };
  }
}
