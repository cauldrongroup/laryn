import { useEffect, useRef, useState } from "react";
import type { CleanupTier } from "@laryn/shared";
import type { DesktopStatus } from "../preload/preload";

export type RecorderState = "idle" | "recording" | "transcribing" | "error";

export type FlowState = "idle" | "recording" | "processing" | "error";

type AudioMonitorGraph = {
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
};

const INITIAL_STATUS: DesktopStatus = {
  authStatus: "signed-out",
  hotkey: "Control+Super",
  hotkeyStatus: {
    activeHotkey: "Control+Super",
    mode: "error"
  },
  isRecording: false,
  state: "idle",
  message: "Starting",
  workerStatus: "unknown",
  workerUrl: ""
};

export type UseRecorderOptions = {
  onWaveformSample?: (sample: number, index: number, total: number) => void;
  onWaveformReset?: () => void;
};

export function useRecorder(options: UseRecorderOptions = {}) {
  const onWaveformSample = options.onWaveformSample;
  const onWaveformReset = options.onWaveformReset;

  const [status, setStatus] = useState<DesktopStatus>(INITIAL_STATUS);
  const [recorderState, setRecorderState] = useState<RecorderState>("idle");
  const [audioInputs, setAudioInputs] = useState<MediaDeviceInfo[]>([]);
  const [selectedAudioInputId, setSelectedAudioInputId] = useState<string>(() => readAudioInputId());
  const [cleanupTier, setCleanupTier] = useState<CleanupTier>(() => readCleanupTier());
  const [elapsedMs, setElapsedMs] = useState(0);

  const cleanupTierRef = useRef(cleanupTier);
  const selectedAudioInputIdRef = useRef(selectedAudioInputId);
  const onWaveformSampleRef = useRef(onWaveformSample);
  const onWaveformResetRef = useRef(onWaveformReset);

  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const startedAt = useRef(0);
  const analyser = useRef<AnalyserNode | null>(null);
  const audioContext = useRef<AudioContext | null>(null);
  const audioMonitorGraph = useRef<AudioMonitorGraph | null>(null);
  const activeStream = useRef<MediaStream | null>(null);
  const animation = useRef<number | null>(null);
  const elapsedTimer = useRef<number | null>(null);

  useEffect(() => {
    cleanupTierRef.current = cleanupTier;
  }, [cleanupTier]);

  useEffect(() => {
    selectedAudioInputIdRef.current = selectedAudioInputId;
  }, [selectedAudioInputId]);

  useEffect(() => {
    onWaveformSampleRef.current = onWaveformSample;
  }, [onWaveformSample]);

  useEffect(() => {
    onWaveformResetRef.current = onWaveformReset;
  }, [onWaveformReset]);

  useEffect(() => {
    let mounted = true;
    void window.laryn.ready().then((next) => {
      if (mounted) setStatus(next);
    });
    void window.laryn.checkWorker().then((next) => {
      if (mounted) setStatus(next);
    });
    void refreshAudioInputs();

    const removeStatusListener = window.laryn.onStatus((next) => {
      if (mounted) setStatus(next);
    });
    const removeStartListener = window.laryn.onStartRecording(() => void startRecording());
    const removeStopListener = window.laryn.onStopRecording(() => void stopRecording());
    navigator.mediaDevices?.addEventListener?.("devicechange", refreshAudioInputs);

    return () => {
      mounted = false;
      removeStatusListener();
      removeStartListener();
      removeStopListener();
      navigator.mediaDevices?.removeEventListener?.("devicechange", refreshAudioInputs);
      cleanupRecordingResources();
    };
  }, []);

  async function refreshAudioInputs() {
    try {
      const inputs = await listAudioInputs();
      setAudioInputs(inputs);

      if (
        selectedAudioInputIdRef.current &&
        !inputs.some((device) => device.deviceId === selectedAudioInputIdRef.current)
      ) {
        setSelectedAudioInputId("");
        selectedAudioInputIdRef.current = "";
        localStorage.setItem("laryn.audioInputId", "");
      }
    } catch (error) {
      console.error("Could not enumerate audio inputs", error);
    }
  }

  async function requestMicrophoneAndRefresh() {
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      await refreshAudioInputs();
    } catch (error) {
      setRecorderState("error");
      window.laryn.recordingFailed(recordingErrorMessage(error));
      console.error(error);
    } finally {
      stream?.getTracks().forEach((track) => track.stop());
    }
  }

  async function startRecording() {
    if (recorder.current?.state === "recording") return;

    let stream: MediaStream | null = null;
    let context: AudioContext | null = null;
    try {
      const requestedDeviceId = selectedAudioInputIdRef.current;
      stream = await getMicrophoneStream(requestedDeviceId, () => {
        setSelectedAudioInputId("");
        selectedAudioInputIdRef.current = "";
        localStorage.setItem("laryn.audioInputId", "");
      });
      void refreshAudioInputs();
      activeStream.current = stream;
      chunks.current = [];
      startedAt.current = performance.now();
      setElapsedMs(0);
      elapsedTimer.current = window.setInterval(() => {
        setElapsedMs(Math.round(performance.now() - startedAt.current));
      }, 200);

      context = new AudioContext();
      audioContext.current = context;
      const monitorGraph = createAudioMonitorGraph(context, stream);
      audioMonitorGraph.current = monitorGraph;
      analyser.current = monitorGraph.analyser;
      monitorLevel();

      const mediaRecorder = createMediaRecorder(stream);
      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunks.current.push(event.data);
        }
      };
      const recordingStream = stream;
      mediaRecorder.onstop = () => {
        void submitRecording(mediaRecorder.mimeType, recordingStream);
      };
      mediaRecorder.start(250);
      recorder.current = mediaRecorder;
      setRecorderState("recording");

      const track = stream.getAudioTracks()[0];
      const activeDeviceId = selectedAudioInputIdRef.current;
      window.laryn.recordingStarted({
        deviceId: activeDeviceId || "default",
        deviceLabel: audioInputLabel(
          audioInputs.find((device) => device.deviceId === activeDeviceId),
          activeDeviceId
        ),
        trackLabel: track?.label
      });
    } catch (error) {
      cleanupRecordingResources(stream);
      setRecorderState("error");
      window.laryn.recordingFailed(recordingErrorMessage(error));
      console.error(error);
    }
  }

  async function stopRecording() {
    if (recorder.current?.state !== "recording") return;
    setRecorderState("transcribing");
    window.laryn.recordingStopped();
    recorder.current.stop();
  }

  async function submitRecording(mimeType: string, stream: MediaStream) {
    const durationMs = Math.round(performance.now() - startedAt.current);
    cleanupRecordingResources(stream);

    const blob = new Blob(chunks.current, { type: mimeType });
    if (blob.size === 0 || durationMs < 250) {
      setRecorderState("idle");
      recorder.current = null;
      window.laryn.recordingCancelled("Hold the hotkey a little longer to dictate");
      return;
    }

    const buffer = await blob.arrayBuffer();
    try {
      await window.laryn.transcribeAudio(buffer, mimeType, durationMs, cleanupTierRef.current);
      setRecorderState("idle");
      recorder.current = null;
    } catch (error) {
      setRecorderState("error");
      recorder.current = null;
      console.error(error);
    }
  }

  function monitorLevel() {
    const node = analyser.current;
    if (!node) return;

    const data = new Uint8Array(node.frequencyBinCount);
    node.getByteFrequencyData(data);

    const callback = onWaveformSampleRef.current;
    if (callback) {
      const total = 24;
      for (let index = 0; index < total; index += 1) {
        const sample = data[Math.floor((index / total) * data.length)] ?? 0;
        callback(sample, index, total);
      }
    }
    animation.current = requestAnimationFrame(monitorLevel);
  }

  function cleanupRecordingResources(stream = activeStream.current): void {
    stream?.getTracks().forEach((track) => track.stop());
    activeStream.current = null;

    if (audioMonitorGraph.current) {
      audioMonitorGraph.current.source.disconnect();
      audioMonitorGraph.current.analyser.disconnect();
      audioMonitorGraph.current = null;
    }

    analyser.current = null;

    if (elapsedTimer.current) {
      window.clearInterval(elapsedTimer.current);
      elapsedTimer.current = null;
    }

    if (animation.current) {
      cancelAnimationFrame(animation.current);
      animation.current = null;
    }

    if (audioContext.current?.state !== "closed") {
      void audioContext.current?.close();
    }
    audioContext.current = null;

    onWaveformResetRef.current?.();
  }

  function selectAudioInput(deviceId: string) {
    setSelectedAudioInputId(deviceId);
    localStorage.setItem("laryn.audioInputId", deviceId);
  }

  function selectCleanupTier(tier: CleanupTier) {
    setCleanupTier(tier);
    localStorage.setItem("laryn.cleanupTier", tier);
    localStorage.setItem("laryn.cleanupTierDefaultVersion", CLEANUP_TIER_DEFAULT_VERSION);
  }

  const flowState: FlowState =
    recorderState === "recording"
      ? "recording"
      : status.state === "transcribing" || status.state === "pasting"
        ? "processing"
        : status.state === "error" || recorderState === "error"
          ? "error"
          : "idle";

  return {
    status,
    recorderState,
    flowState,
    elapsedMs,
    audioInputs,
    selectedAudioInputId,
    cleanupTier,
    startRecording,
    stopRecording,
    selectAudioInput,
    selectCleanupTier,
    requestMicrophoneAndRefresh,
    refreshAudioInputs,
    setStatus
  };
}

const CLEANUP_TIER_DEFAULT_VERSION = "3";

function readCleanupTier(): CleanupTier {
  if (localStorage.getItem("laryn.cleanupTierDefaultVersion") !== CLEANUP_TIER_DEFAULT_VERSION) {
    localStorage.setItem("laryn.cleanupTier", "off");
    localStorage.setItem("laryn.cleanupTierDefaultVersion", CLEANUP_TIER_DEFAULT_VERSION);
    return "off";
  }

  const value = localStorage.getItem("laryn.cleanupTier");
  return value === "off" || value === "cheap" || value === "premium" || value === "standard"
    ? value
    : "off";
}

function readAudioInputId(): string {
  return localStorage.getItem("laryn.audioInputId") || "";
}

function buildAudioConstraints(deviceId: string): MediaTrackConstraints {
  return {
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true
  };
}

async function getMicrophoneStream(deviceId: string, onFallbackToDefault: () => void): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: buildAudioConstraints(deviceId)
    });
  } catch (error) {
    if (!deviceId || !isDeviceSelectionError(error)) throw error;
    onFallbackToDefault();
    return navigator.mediaDevices.getUserMedia({
      audio: buildAudioConstraints("")
    });
  }
}

function createAudioMonitorGraph(context: AudioContext, stream: MediaStream): AudioMonitorGraph {
  const source = context.createMediaStreamSource(stream);
  const analyserNode = context.createAnalyser();
  analyserNode.fftSize = 128;
  source.connect(analyserNode);
  return { source, analyser: analyserNode };
}

function createMediaRecorder(stream: MediaStream): MediaRecorder {
  const mimeType = preferredMimeType();
  return mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
}

async function listAudioInputs(): Promise<MediaDeviceInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((device) => device.kind === "audioinput");
}

export function audioInputLabel(device: MediaDeviceInfo | undefined, deviceId: string, index = 0): string {
  if (device?.label) return device.label;
  if (!deviceId) return "System default";
  return `Microphone ${index + 1}`;
}

export function selectedAudioInputName(devices: MediaDeviceInfo[], selectedDeviceId: string): string {
  if (!selectedDeviceId) return "System default";
  return audioInputLabel(
    devices.find((device) => device.deviceId === selectedDeviceId),
    selectedDeviceId
  );
}

export function cleanupModelLabel(tier: CleanupTier): string {
  if (tier === "off") return "No cleanup";
  if (tier === "cheap") return "Llama 1B";
  if (tier === "premium") return "Llama 8B Fast";
  return "Llama 3B";
}

export function tierLabel(tier: CleanupTier): string {
  if (tier === "off") return "Raw";
  if (tier === "cheap") return "Fast";
  if (tier === "premium") return "Best";
  return "Balanced";
}

function preferredMimeType(): string {
  const options = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
  return options.find((option) => MediaRecorder.isTypeSupported(option)) ?? "";
}

function isDeviceSelectionError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === "NotFoundError" || error.name === "OverconstrainedError" || error.name === "NotReadableError")
  );
}

export function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function recordingErrorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === "NotAllowedError") {
    return "Microphone permission was denied";
  }
  if (error instanceof Error && error.message) {
    return `Could not start recording: ${error.message}`;
  }
  return "Could not start recording";
}

export function displayHotkey(hotkey: string): string {
  return hotkey.replace("Control", "Ctrl").replace("Super", "Win").replaceAll("+", " + ");
}
