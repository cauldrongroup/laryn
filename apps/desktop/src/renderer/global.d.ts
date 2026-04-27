import type { DesktopStatus, RecordingMetadata } from "../preload/preload";
import type { CleanupTier, HistoryEntry, TranscriptionResponse } from "@laryn/shared";

declare global {
  interface Window {
    laryn: {
      ready: () => Promise<DesktopStatus>;
      setHotkey: (hotkey: string) => Promise<DesktopStatus>;
      checkForUpdates: () => Promise<DesktopStatus>;
      checkWorker: () => Promise<DesktopStatus>;
      startDeviceLogin: () => Promise<{ deviceCode: string; userCode: string; verificationUri: string; expiresIn: number }>;
      pollDeviceLogin: (deviceCode: string, deviceName?: string) => Promise<{ status: "pending" | "approved"; token?: string }>;
      logout: () => Promise<{ ok: boolean }>;
      getAccountStatus: () => Promise<unknown>;
      openAccount: () => Promise<void>;
      minimizeWindow: () => void;
      closeWindow: () => void;
      recordingStarted: (metadata?: RecordingMetadata) => void;
      recordingStopped: () => void;
      recordingCancelled: (message: string) => void;
      recordingFailed: (message: string) => void;
      transcribeAudio: (audio: ArrayBuffer, mimeType: string, durationMs: number, cleanupTier: CleanupTier) => Promise<TranscriptionResponse>;
      listHistory: () => Promise<HistoryEntry[]>;
      deleteHistoryEntry: (id: string) => Promise<HistoryEntry[]>;
      clearHistory: () => Promise<HistoryEntry[]>;
      copyToClipboard: (text: string) => void;
      onStartRecording: (callback: () => void) => () => void;
      onStopRecording: (callback: () => void) => () => void;
      onStatus: (callback: (status: DesktopStatus) => void) => () => void;
      onHistoryChanged: (callback: (history: HistoryEntry[]) => void) => () => void;
    };
  }
}
