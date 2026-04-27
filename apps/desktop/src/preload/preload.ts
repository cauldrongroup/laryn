import { contextBridge, ipcRenderer } from "electron";
import type { CleanupTier, DictionaryEntry, HistoryEntry, TranscriptionResponse } from "@laryn/shared";

contextBridge.exposeInMainWorld("laryn", {
  ready: () => ipcRenderer.invoke("renderer:ready"),
  setHotkey: (hotkey: string) => ipcRenderer.invoke("settings:set-hotkey", hotkey),
  checkForUpdates: () => ipcRenderer.invoke("updates:check"),
  checkWorker: () => ipcRenderer.invoke("worker:check"),
  startDeviceLogin: () => ipcRenderer.invoke("auth:start-device-login"),
  pollDeviceLogin: (deviceCode: string, deviceName?: string) => ipcRenderer.invoke("auth:poll-device-login", deviceCode, deviceName),
  logout: () => ipcRenderer.invoke("auth:logout"),
  getAccountStatus: () => ipcRenderer.invoke("auth:get-account-status"),
  openAccount: () => ipcRenderer.invoke("auth:open-account"),
  minimizeWindow: () => ipcRenderer.send("window:minimize"),
  closeWindow: () => ipcRenderer.send("window:close"),
  recordingStarted: (metadata?: RecordingMetadata) => ipcRenderer.send("recording:started", metadata),
  recordingStopped: () => ipcRenderer.send("recording:stopped"),
  recordingCancelled: (message: string) => ipcRenderer.send("recording:cancelled", message),
  recordingFailed: (message: string) => ipcRenderer.send("recording:failed", message),
  transcribeAudio: (audio: ArrayBuffer, mimeType: string, durationMs: number, cleanupTier: CleanupTier, dictionary?: DictionaryEntry[]) =>
    ipcRenderer.invoke("transcription:submit", audio, mimeType, durationMs, cleanupTier, dictionary),
  listHistory: (): Promise<HistoryEntry[]> => ipcRenderer.invoke("history:list"),
  deleteHistoryEntry: (id: string): Promise<HistoryEntry[]> => ipcRenderer.invoke("history:delete", id),
  clearHistory: (): Promise<HistoryEntry[]> => ipcRenderer.invoke("history:clear"),
  listDictionary: (): Promise<DictionaryEntry[]> => ipcRenderer.invoke("dictionary:list"),
  saveDictionaryEntry: (entry: Partial<DictionaryEntry>): Promise<DictionaryEntry[]> => ipcRenderer.invoke("dictionary:save", entry),
  deleteDictionaryEntry: (id: string): Promise<DictionaryEntry[]> => ipcRenderer.invoke("dictionary:delete", id),
  toggleDictionaryEntry: (id: string, enabled: boolean): Promise<DictionaryEntry[]> => ipcRenderer.invoke("dictionary:toggle", id, enabled),
  copyToClipboard: (text: string) => ipcRenderer.send("history:copy", text),
  onStartRecording: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on("recording:start", listener);
    return () => ipcRenderer.removeListener("recording:start", listener);
  },
  onStopRecording: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on("recording:stop", listener);
    return () => ipcRenderer.removeListener("recording:stop", listener);
  },
  onStatus: (callback: (status: DesktopStatus) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: DesktopStatus) => callback(status);
    ipcRenderer.on("desktop:status", listener);
    return () => ipcRenderer.removeListener("desktop:status", listener);
  },
  onHistoryChanged: (callback: (history: HistoryEntry[]) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, history: HistoryEntry[]) => callback(history);
    ipcRenderer.on("desktop:history-changed", listener);
    return () => ipcRenderer.removeListener("desktop:history-changed", listener);
  }
});

export type DesktopStatus = {
  appVersion: string;
  authStatus: "ok" | "signed-out" | "pending" | "subscription-required" | "unauthorized" | "unknown";
  account?: {
    id: string;
    name: string;
    email: string;
    image?: string | null;
  } | null;
  billing?: {
    proActive: boolean;
    subscriptionStatus: string;
    currentPeriodEnd?: string;
    polarCustomerId?: string;
    usageCredits?: {
      includedUnits: number;
      includedCents: number;
      consumedUnits?: number;
      creditedUnits?: number;
      balanceUnits?: number;
      consumedCents?: number;
      remainingCents?: number;
      overageCents?: number;
    };
  } | null;
  deviceLogin?: {
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    expiresAt: string;
  };
  hotkey: string;
  hotkeyStatus: {
    activeHotkey: string;
    error?: string;
    lastEventAt?: string;
    mode: "native-hold" | "electron-toggle-fallback" | "error";
  };
  isRecording: boolean;
  updateStatus: "idle" | "checking" | "current" | "downloading" | "ready" | "error" | "disabled";
  updateMessage: string;
  updateVersion?: string;
  state: "idle" | "recording" | "transcribing" | "pasting" | "error";
  message: string;
  lastTranscript?: TranscriptionResponse;
  releaseName: string;
  workerStatus: "online" | "offline" | "unauthorized" | "unknown";
  workerUrl: string;
};

export type RecordingMetadata = {
  deviceId?: string;
  deviceLabel?: string;
  trackLabel?: string;
};
