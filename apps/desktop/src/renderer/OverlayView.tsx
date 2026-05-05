import { useCallback, useMemo, useRef } from "react";
import { Mic, Square } from "lucide-react";
import { displayHotkey, formatElapsed, useRecorder } from "./useRecorder";
import type { FlowState } from "./useRecorder";

const BAR_COUNT = 24;
const WAVEFORM_BAR_INDICES = Array.from({ length: BAR_COUNT }, (_, index) => index);

export default function OverlayView() {
  const waveformBars = useRef<Array<HTMLSpanElement | null>>([]);

  const onWaveformSample = useCallback((sample: number, index: number, total: number) => {
    const bar = waveformBars.current[index];
    if (!bar) return;
    const ratio = sample / 255;
    const height = 14 + ratio * 70;
    bar.style.height = `${height}%`;
    bar.style.opacity = String(0.4 + ratio * 0.6);
    void total;
  }, []);

  const onWaveformReset = useCallback(() => {
    for (const bar of waveformBars.current) {
      if (!bar) continue;
      bar.style.height = "14%";
      bar.style.opacity = "0.4";
    }
  }, []);

  const recorder = useRecorder({
    onWaveformSample,
    onWaveformReset,
    checkWorkerOnMount: false,
    hydrateAudioInputs: false
  });
  const { status, flowState, elapsedMs, stopRecording } = recorder;

  const hotkey = useMemo(() => displayHotkey(status.hotkey), [status.hotkey]);

  const headline = headlineFor(flowState);
  const caption = captionFor(flowState, hotkey, status.message);
  const showStop = flowState === "recording";

  return (
    <div className="overlay-shell">
      <div className="overlay-card" data-state={flowState}>
        <div className={`overlay-mic ${flowState === "recording" ? "mic-pulse" : ""}`}>
          <Mic size={20} />
        </div>

        <div className="min-w-0 grid">
          <strong className="truncate text-sm font-semibold tracking-tight text-white">
            {headline}
          </strong>
          <span className="truncate text-xs text-[color:var(--color-text-soft)]">
            {caption}
          </span>
        </div>

        <div className={`wave wave-${flowState} h-10 w-44`}>
          {WAVEFORM_BAR_INDICES.map((index) => (
            <span
              key={index}
              ref={(node) => {
                waveformBars.current[index] = node;
              }}
            />
          ))}
        </div>

        <div className="flex items-center gap-2">
          <span className="rounded-md bg-white/5 px-2 py-1 text-xs font-semibold tabular-nums text-[color:var(--color-text-soft)]">
            {formatElapsed(elapsedMs)}
          </span>
          {showStop ? (
            <button
              className="btn btn-danger px-2 py-1.5"
              type="button"
              aria-label="Stop recording"
              onClick={() => void stopRecording()}
            >
              <Square size={12} />
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function headlineFor(state: FlowState): string {
  if (state === "recording") return "Listening";
  if (state === "processing") return "Transcribing";
  if (state === "error") return "Needs attention";
  return "Ready";
}

function captionFor(state: FlowState, hotkey: string, message: string): string {
  if (state === "recording") return `Release ${hotkey} to transcribe`;
  if (state === "processing") return "Pasting clean text into the active app";
  if (state === "error") return message || "Check microphone, Worker, or auth";
  return `Hold ${hotkey} and speak`;
}
