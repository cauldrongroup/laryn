import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, ClipboardCheck, Mic, Radio, Settings, Waves } from "lucide-react";
import type { DesktopStatus } from "../preload/preload";
import type { CleanupTier } from "@laryn/shared";
import "./styles.css";

type RecorderState = "idle" | "recording" | "transcribing" | "error";

export default function App() {
  const [status, setStatus] = useState<DesktopStatus>({
    authStatus: "unknown",
    hotkey: "Control+Super",
    hotkeyStatus: {
      activeHotkey: "Control+Super",
      mode: "error",
    },
    isRecording: false,
    state: "idle",
    message: "Starting",
    workerStatus: "unknown",
    workerUrl: "http://127.0.0.1:8787",
  });
  const [recorderState, setRecorderState] = useState<RecorderState>("idle");
  const [cleanupTier, setCleanupTier] = useState<CleanupTier>(() => readCleanupTier());
  const cleanupTierRef = useRef(cleanupTier);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const startedAt = useRef(0);
  const analyser = useRef<AnalyserNode | null>(null);
  const animation = useRef<number | null>(null);
  const ring = useRef<HTMLDivElement | null>(null);

  const displayHotkey = useMemo(
    () => status.hotkey.replace("Control", "Ctrl").replace("Super", "Win").replaceAll("+", " + "),
    [status.hotkey]
  );

  useEffect(() => {
    cleanupTierRef.current = cleanupTier;
  }, [cleanupTier]);

  useEffect(() => {
    void window.laryn.ready().then(setStatus);
    void window.laryn.checkWorker().then(setStatus);
    window.laryn.onStatus(setStatus);
    window.laryn.onStartRecording(() => void startRecording());
    window.laryn.onStopRecording(() => void stopRecording());

    return () => {
      if (animation.current) {
        cancelAnimationFrame(animation.current);
      }
    };
  }, []);

  async function startRecording() {
    if (recorder.current?.state === "recording") {
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      chunks.current = [];
      startedAt.current = performance.now();

      const context = new AudioContext();
      const source = context.createMediaStreamSource(stream);
      analyser.current = context.createAnalyser();
      analyser.current.fftSize = 128;
      source.connect(analyser.current);
      monitorLevel();

      const mediaRecorder = new MediaRecorder(stream, { mimeType: preferredMimeType() });
      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunks.current.push(event.data);
        }
      };
      mediaRecorder.onstop = () => {
        void submitRecording(mediaRecorder.mimeType, stream);
      };
      mediaRecorder.start();
      recorder.current = mediaRecorder;
      setRecorderState("recording");
      window.laryn.recordingStarted();
    } catch (error) {
      setRecorderState("error");
      console.error(error);
    }
  }

  async function stopRecording() {
    if (recorder.current?.state !== "recording") {
      return;
    }

    setRecorderState("transcribing");
    window.laryn.recordingStopped();
    recorder.current.stop();
  }

  async function submitRecording(mimeType: string, stream: MediaStream) {
    stream.getTracks().forEach((track) => track.stop());
    if (animation.current) {
      cancelAnimationFrame(animation.current);
    }
    setRingScale(1);

    const blob = new Blob(chunks.current, { type: mimeType });
    const buffer = await blob.arrayBuffer();
    const durationMs = Math.round(performance.now() - startedAt.current);
    try {
      await window.laryn.transcribeAudio(buffer, mimeType, durationMs, cleanupTierRef.current);
      setRecorderState("idle");
    } catch (error) {
      setRecorderState("error");
      console.error(error);
    }
  }

  function monitorLevel() {
    const node = analyser.current;
    if (!node) {
      return;
    }

    const data = new Uint8Array(node.frequencyBinCount);
    node.getByteFrequencyData(data);
    const nextLevel = data.reduce((sum, value) => sum + value, 0) / data.length / 255;
    setRingScale(1 + nextLevel * 0.18);
    animation.current = requestAnimationFrame(monitorLevel);
  }

  function setRingScale(scale: number): void {
    if (ring.current) {
      ring.current.style.transform = `scale(${scale})`;
    }
  }

  const visualState = recorderState === "recording" ? "recording" : status.state;

  return (
    <main className="shell">
      <section className="topbar">
        <div className="brand">
          <span className="brandMark"><Waves size={18} /></span>
          <span>Laryn</span>
        </div>
        <button className="iconButton" aria-label="Settings">
          <Settings size={18} />
        </button>
      </section>

      <section className={`orb ${visualState}`}>
        <div className="ring" ref={ring} />
        <div className="micCore">
          <Mic size={54} strokeWidth={1.35} />
        </div>
      </section>

      <section className="statusPanel">
        <p className="eyebrow">{displayHotkey}</p>
        <h1>{headline(status.state, recorderState)}</h1>
        <p className="message">{status.message}</p>
      </section>

      <section className="metrics">
        <div>
          <Radio size={17} />
          <span>Hotkey</span>
          <strong>{status.hotkeyStatus.mode}</strong>
        </div>
        <div>
          <Activity size={17} />
          <span>Worker</span>
          <strong>{status.workerStatus}</strong>
        </div>
        <div>
          <ClipboardCheck size={17} />
          <span>Auth</span>
          <strong>{status.authStatus}</strong>
        </div>
      </section>

      <section className="diagnosticsPanel">
        <span>{status.workerUrl}</span>
        <button onClick={() => void window.laryn.checkWorker().then(setStatus)}>Check</button>
      </section>

      <section className="settingsPanel">
        <div className="panelHeader">
          <span>Cleanup quality</span>
          <strong>{cleanupModelLabel(cleanupTier)}</strong>
        </div>
        <div className="segments" role="group" aria-label="Cleanup quality">
          {(["cheap", "standard", "premium"] as CleanupTier[]).map((tier) => (
            <button
              key={tier}
              disabled={recorderState === "recording"}
              className={cleanupTier === tier ? "active" : ""}
              onClick={() => {
                setCleanupTier(tier);
                localStorage.setItem("laryn.cleanupTier", tier);
              }}
            >
              {tier}
            </button>
          ))}
        </div>
        <p>Laryn lightly fixes punctuation and obvious dictation artifacts without rewriting your voice.</p>
      </section>

      {status.lastTranscript ? (
        <section className="transcript">
          <div className="transcriptMeta">
            <span>{status.lastTranscript.cleanupApplied ? "Cleaned" : "Raw used"}</span>
            <span>{status.lastTranscript.cleanupTier}</span>
            <span>{status.lastTranscript.cleanupModel ?? "No cleanup model"}</span>
            {status.lastTranscript.fallbackUsed ? <span>Fallback used</span> : null}
          </div>
          <p>{status.lastTranscript.cleanedText || status.lastTranscript.text}</p>
          <details>
            <summary>Raw Nova-3 transcript</summary>
            <p>{status.lastTranscript.rawText || "No raw transcript captured."}</p>
          </details>
          {status.lastTranscript.cleanupWarning ? (
            <p className="warning">{status.lastTranscript.cleanupWarning}</p>
          ) : null}
        </section>
      ) : null}
    </main>
  );
}

function readCleanupTier(): CleanupTier {
  const value = localStorage.getItem("laryn.cleanupTier");
  return value === "cheap" || value === "premium" || value === "standard" ? value : "standard";
}

function cleanupModelLabel(tier: CleanupTier): string {
  if (tier === "cheap") return "Granite Micro";
  if (tier === "premium") return "Llama 70B";
  return "Qwen 30B";
}

function preferredMimeType(): string {
  const options = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
  return options.find((option) => MediaRecorder.isTypeSupported(option)) ?? "";
}

function headline(state: DesktopStatus["state"], recorderState: RecorderState): string {
  if (recorderState === "recording") return "Listening";
  if (recorderState === "transcribing" || state === "transcribing") return "Transcribing";
  if (state === "pasting") return "Writing";
  if (state === "error" || recorderState === "error") return "Needs attention";
  return "Press the chord and speak";
}
