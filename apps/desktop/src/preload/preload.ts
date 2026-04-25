import { contextBridge, ipcRenderer } from "electron";
import type { CleanupTier, TranscriptionResponse } from "@laryn/shared";

contextBridge.exposeInMainWorld("laryn", {
  ready: () => ipcRenderer.invoke("renderer:ready"),
  checkWorker: () => ipcRenderer.invoke("worker:check"),
  recordingStarted: () => ipcRenderer.send("recording:started"),
  recordingStopped: () => ipcRenderer.send("recording:stopped"),
  transcribeAudio: (audio: ArrayBuffer, mimeType: string, durationMs: number, cleanupTier: CleanupTier) =>
    ipcRenderer.invoke("transcription:submit", audio, mimeType, durationMs, cleanupTier),
  onStartRecording: (callback: () => void) => {
    ipcRenderer.on("recording:start", callback);
  },
  onStopRecording: (callback: () => void) => {
    ipcRenderer.on("recording:stop", callback);
  },
  onStatus: (callback: (status: DesktopStatus) => void) => {
    ipcRenderer.on("desktop:status", (_event, status: DesktopStatus) => callback(status));
  }
});

export type DesktopStatus = {
  authStatus: "ok" | "missing-token" | "unauthorized" | "unknown";
  hotkey: string;
  hotkeyStatus: {
    activeHotkey: string;
    error?: string;
    lastEventAt?: string;
    mode: "native-hold" | "electron-toggle-fallback" | "error";
  };
  isRecording: boolean;
  state: "idle" | "recording" | "transcribing" | "pasting" | "error";
  message: string;
  lastTranscript?: TranscriptionResponse;
  workerStatus: "online" | "offline" | "unauthorized" | "unknown";
  workerUrl: string;
};
