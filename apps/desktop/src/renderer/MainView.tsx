import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  ClipboardCopy,
  ExternalLink,
  History,
  KeyRound,
  LogOut,
  Mic,
  Minus,
  RefreshCw,
  Search,
  Settings,
  Square,
  Trash2,
  UserRound,
  Waves,
  X
} from "lucide-react";
import type { CleanupTier, HistoryEntry } from "@laryn/shared";
import type { DesktopStatus } from "../preload/preload";
import {
  audioInputLabel,
  cleanupModelLabel,
  displayHotkey,
  formatElapsed,
  tierLabel,
  useRecorder
} from "./useRecorder";
import type { FlowState } from "./useRecorder";

const BAR_COUNT = 28;

type RouteId = "dictate" | "history";

export default function MainView() {
  const waveformBars = useRef<Array<HTMLSpanElement | null>>([]);

  const onWaveformSample = useCallback((sample: number, index: number) => {
    const bar = waveformBars.current[index];
    if (!bar) return;
    const ratio = sample / 255;
    const height = 12 + ratio * 76;
    bar.style.height = `${height}%`;
    bar.style.opacity = String(0.4 + ratio * 0.6);
  }, []);

  const onWaveformReset = useCallback(() => {
    for (const bar of waveformBars.current) {
      if (!bar) continue;
      bar.style.height = "14%";
      bar.style.opacity = "0.4";
    }
  }, []);

  const recorder = useRecorder({ onWaveformSample, onWaveformReset });
  const {
    status,
    recorderState,
    flowState,
    elapsedMs,
    audioInputs,
    selectedAudioInputId,
    cleanupTier,
    selectAudioInput,
    selectCleanupTier,
    requestMicrophoneAndRefresh,
    stopRecording,
    setStatus
  } = recorder;

  const [route, setRoute] = useState<RouteId>("dictate");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [deviceLoginError, setDeviceLoginError] = useState("");
  const [hotkeyError, setHotkeyError] = useState("");

  const hotkey = useMemo(() => displayHotkey(status.hotkey), [status.hotkey]);
  const hotkeyParts = useMemo(() => splitHotkey(hotkey), [hotkey]);

  useEffect(() => {
    if (
      recorderState === "recording" ||
      recorderState === "transcribing" ||
      status.state === "transcribing" ||
      status.state === "pasting"
    ) {
      setSettingsOpen(false);
    }
  }, [recorderState, status.state]);

  useEffect(() => {
    const deviceCode = status.deviceLogin?.deviceCode;
    if (!deviceCode || status.authStatus !== "pending") return;

    let cancelled = false;
    let polling = false;
    const poll = () => {
      if (cancelled || polling) return;
      polling = true;
      void window.laryn
        .pollDeviceLogin(deviceCode)
        .then((result) => {
          if (cancelled) return;
          if (result.status === "approved") {
            cancelled = true;
            window.clearInterval(timer);
            setDeviceLoginError("");
            void window.laryn.checkWorker().then(setStatus);
          }
        })
        .catch((error) => {
          if (cancelled) return;
          setDeviceLoginError(error instanceof Error ? error.message : String(error));
          window.clearInterval(timer);
        })
        .finally(() => {
          polling = false;
        });
    };

    poll();
    const timer = window.setInterval(poll, 2500);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [status.authStatus, status.deviceLogin?.deviceCode, setStatus]);

  const settingsAvailable =
    recorderState !== "recording" &&
    recorderState !== "transcribing" &&
    status.state !== "transcribing" &&
    status.state !== "pasting";

  const recordingControlsDisabled = recorderState === "recording";

  return (
    <div className="grid h-full grid-cols-[200px_minmax(0,1fr)] grid-rows-[36px_1fr] overflow-hidden">
      <NavRail
        status={status}
        hotkey={hotkey}
        route={route}
        onNavigate={setRoute}
        onSettings={() => setSettingsOpen(true)}
      />

      <Titlebar onSettings={() => setSettingsOpen(true)} />

      <main className="scroll-soft col-start-2 row-start-2 min-h-0 overflow-auto">
        {route === "dictate" ? (
          <div className="grid gap-3 p-6">
            <FlowPanel
              flowState={flowState}
              hotkeyParts={hotkeyParts}
              elapsedMs={elapsedMs}
              waveformBars={waveformBars}
              status={status}
              onStop={() => void stopRecording()}
            />

            {status.lastTranscript ? (
              <LatestTranscriptCard
                status={status}
                onOpenHistory={() => setRoute("history")}
              />
            ) : null}
          </div>
        ) : (
          <HistoryRoute onBack={() => setRoute("dictate")} />
        )}
      </main>

      {settingsOpen && settingsAvailable ? (
        <SettingsDrawer
          status={status}
          hotkey={hotkey}
          cleanupTier={cleanupTier}
          audioInputs={audioInputs}
          selectedAudioInputId={selectedAudioInputId}
          deviceLoginError={deviceLoginError}
          hotkeyError={hotkeyError}
          recordingControlsDisabled={recordingControlsDisabled}
          onClose={() => setSettingsOpen(false)}
          onSelectCleanupTier={selectCleanupTier}
          onSelectAudioInput={selectAudioInput}
          onRefreshInputs={() => void requestMicrophoneAndRefresh()}
          onCheckWorker={() => void window.laryn.checkWorker().then(setStatus)}
          onSetHotkey={async (nextHotkey) => {
            setHotkeyError("");
            try {
              const nextStatus = await window.laryn.setHotkey(nextHotkey);
              setStatus(nextStatus);
            } catch (error) {
              setHotkeyError(error instanceof Error ? error.message : String(error));
            }
          }}
          onStartLogin={async () => {
            setDeviceLoginError("");
            try {
              await window.laryn.startDeviceLogin();
            } catch (error) {
              setDeviceLoginError(error instanceof Error ? error.message : String(error));
            }
          }}
          onLogout={async () => {
            setDeviceLoginError("");
            await window.laryn.logout();
            void window.laryn.ready().then(setStatus);
          }}
        />
      ) : null}
    </div>
  );
}

function Titlebar({ onSettings }: { onSettings: () => void }) {
  return (
    <header className="app-drag col-start-2 row-start-1 flex items-center justify-end gap-1 bg-[color:var(--color-canvas)] pr-1 pl-3">
      <button className="icon-btn" aria-label="Settings" onClick={onSettings}>
        <Settings size={15} />
      </button>
      <button
        className="icon-btn"
        aria-label="Minimize window"
        onClick={() => window.laryn.minimizeWindow()}
      >
        <Minus size={14} />
      </button>
      <button
        className="icon-btn icon-btn-close"
        aria-label="Close window"
        onClick={() => window.laryn.closeWindow()}
      >
        <X size={14} />
      </button>
    </header>
  );
}

function NavRail({
  status,
  hotkey,
  route,
  onNavigate,
  onSettings
}: {
  status: DesktopStatus;
  hotkey: string;
  route: RouteId;
  onNavigate: (route: RouteId) => void;
  onSettings: () => void;
}) {
  return (
    <aside
      aria-label="Primary"
      className="row-span-2 grid grid-rows-[auto_auto_1fr_auto] gap-1 border-r border-[color:var(--color-line)] bg-[color:var(--color-canvas)] px-3 pb-4 pt-2"
    >
      <div className="app-no-drag mb-3 flex items-center gap-2.5 px-2 py-1.5">
        <span className="grid size-7 place-items-center rounded-md bg-[color:var(--color-brand-soft)] text-[color:var(--color-brand)]">
          <Waves size={14} />
        </span>
        <div className="grid leading-tight">
          <strong className="text-sm font-semibold tracking-tight text-white">
            Laryn
          </strong>
          <span className="text-[11px] text-[color:var(--color-text-mute)]">
            Desktop dictation
          </span>
        </div>
      </div>

      <div className="grid gap-1">
        <button
          className="nav-item"
          type="button"
          data-active={route === "dictate"}
          onClick={() => onNavigate("dictate")}
        >
          <Mic size={15} />
          <span>Dictate</span>
        </button>
        <button
          className="nav-item"
          type="button"
          data-active={route === "history"}
          onClick={() => onNavigate("history")}
        >
          <History size={15} />
          <span>History</span>
        </button>
        <button className="nav-item" type="button" onClick={onSettings}>
          <Settings size={15} />
          <span>Settings</span>
        </button>
      </div>

      <div />

      <div className="grid gap-2.5 border-t border-[color:var(--color-line)] pt-3">
        <NavStatusRow
          label="Worker"
          value={status.workerStatus}
          tone={status.workerStatus === "online" ? "good" : "warn"}
        />
        <NavStatusRow
          label="Auth"
          value={status.authStatus}
          tone={status.authStatus === "ok" ? "good" : "warn"}
        />
        <NavStatusRow
          label="Hotkey"
          value={status.hotkeyStatus.mode === "native-hold" ? hotkey : status.hotkeyStatus.mode}
          tone={status.hotkeyStatus.mode === "error" ? "warn" : "neutral"}
        />
      </div>
    </aside>
  );
}

function NavStatusRow({
  label,
  value,
  tone
}: {
  label: string;
  value: string;
  tone: "good" | "warn" | "neutral";
}) {
  return (
    <div className="grid grid-cols-[auto_1fr] items-center gap-x-2.5 px-2">
      <span
        className={`dot ${tone === "good" ? "dot-good" : tone === "warn" ? "dot-warn" : ""}`}
        aria-hidden="true"
      />
      <span className="text-[11px] uppercase tracking-wide text-[color:var(--color-text-mute)]">
        {label}
      </span>
      <strong className="col-start-2 truncate text-[13px] font-semibold text-white">
        {value}
      </strong>
    </div>
  );
}

function FlowPanel({
  flowState,
  hotkeyParts,
  elapsedMs,
  waveformBars,
  status,
  onStop
}: {
  flowState: FlowState;
  hotkeyParts: string[];
  elapsedMs: number;
  waveformBars: React.MutableRefObject<Array<HTMLSpanElement | null>>;
  status: DesktopStatus;
  onStop: () => void;
}) {
  const headline =
    flowState === "recording"
      ? "Listening"
      : flowState === "processing"
        ? "Cleaning up"
        : flowState === "error"
          ? "Needs attention"
          : "Ready";

  const caption =
    flowState === "recording"
      ? "Release the hotkey to transcribe and paste"
      : flowState === "processing"
        ? "Pasting clean text into the active app"
        : flowState === "error"
          ? status.message || "Check microphone, Worker, or auth status"
          : "Hold the shortcut and speak — Laryn pastes the result";

  return (
    <section
      className="panel grid gap-5 p-6"
      data-state={flowState}
      aria-live="polite"
    >
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-5">
        <div
          className={`overlay-mic ${flowState === "recording" ? "mic-pulse" : ""}`}
          style={{ width: 56, height: 56 }}
        >
          <Mic size={22} />
        </div>

        <div className="grid gap-1">
          <h2 className="m-0 text-balance text-[22px] font-semibold tracking-tight text-white">
            {headline}
          </h2>
          <p className="m-0 max-w-[52ch] text-pretty text-sm text-[color:var(--color-text-soft)]">
            {caption}
          </p>
        </div>

        <div className="flex flex-col items-end gap-2">
          {flowState === "recording" ? (
            <span className="text-2xl font-semibold tabular-nums text-white">
              {formatElapsed(elapsedMs)}
            </span>
          ) : (
            <HotkeyChips parts={hotkeyParts} />
          )}
        </div>
      </div>

      <div
        className={
          flowState === "idle"
            ? "h-px bg-[color:var(--color-line)]"
            : "flex items-center gap-3"
        }
      >
        {flowState === "idle" ? null : flowState === "processing" ? (
          <>
            <div className="shimmer h-1.5 flex-1" aria-hidden="true" />
            <span className="text-xs font-medium text-[color:var(--color-warn)]">
              Transcribing
            </span>
          </>
        ) : (
          <>
            <div className={`wave wave-${flowState} h-12 flex-1`} aria-hidden="true">
              {Array.from({ length: BAR_COUNT }, (_, index) => (
                <span
                  key={index}
                  ref={(node) => {
                    waveformBars.current[index] = node;
                  }}
                />
              ))}
            </div>
            {flowState === "recording" ? (
              <button
                className="btn btn-danger"
                type="button"
                aria-label="Stop recording"
                onClick={onStop}
              >
                <Square size={11} />
                Stop
              </button>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}

function HotkeyChips({ parts }: { parts: string[] }) {
  return (
    <div className="flex items-center gap-1.5">
      {parts.map((part, index) => (
        <span key={`${part}-${index}`} className="contents">
          {part === "+" ? (
            <span aria-hidden="true" className="text-xs text-[color:var(--color-text-mute)]">
              +
            </span>
          ) : (
            <kbd className="kbd">{part}</kbd>
          )}
        </span>
      ))}
    </div>
  );
}

function LatestTranscriptCard({
  status,
  onOpenHistory
}: {
  status: DesktopStatus;
  onOpenHistory: () => void;
}) {
  const transcript = status.lastTranscript;
  if (!transcript) return null;

  const text = transcript.cleanedText || transcript.text;
  const wordCount =
    transcript.wordCount ||
    (text ? text.split(/\s+/).filter(Boolean).length : 0);
  const seconds = Math.max(0, Math.round((transcript.durationMs || 0) / 1000));

  return (
    <section className="panel grid gap-3 p-5">
      <header className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs text-[color:var(--color-text-mute)]">
          <span className="font-semibold uppercase tracking-wide">Just pasted</span>
          <span>·</span>
          <span>{seconds}s</span>
          <span>·</span>
          <span>{wordCount} words</span>
        </div>
        <button
          className="btn btn-ghost px-2.5 py-1 text-xs"
          type="button"
          onClick={onOpenHistory}
        >
          <History size={13} />
          Open history
        </button>
      </header>
      <p className="m-0 max-w-[78ch] text-pretty text-sm leading-6 text-[color:var(--color-text)]">
        {text}
      </p>
    </section>
  );
}

function HistoryRoute({ onBack }: { onBack: () => void }) {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [search, setSearch] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  useEffect(() => {
    let mounted = true;
    void window.laryn.listHistory().then((items) => {
      if (!mounted) return;
      setEntries(items);
      setHydrated(true);
    });
    const unsubscribe = window.laryn.onHistoryChanged((items) => {
      if (mounted) setEntries(items);
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return entries;
    return entries.filter((entry) => {
      const haystack = [
        entry.text,
        entry.rawText ?? "",
        entry.cleanedText ?? "",
        entry.cleanupModel ?? "",
        entry.transcriptionModel ?? ""
      ]
        .join("\n")
        .toLowerCase();
      return haystack.includes(query);
    });
  }, [entries, search]);

  const handleCopy = useCallback((entry: HistoryEntry) => {
    const text = entry.cleanedText || entry.text;
    if (!text) return;
    window.laryn.copyToClipboard(text);
  }, []);

  const handleDelete = useCallback(async (id: string) => {
    setPendingDeleteId(id);
    try {
      const next = await window.laryn.deleteHistoryEntry(id);
      setEntries(next);
    } finally {
      setPendingDeleteId(null);
    }
  }, []);

  const handleClear = useCallback(async () => {
    setConfirmClear(false);
    const next = await window.laryn.clearHistory();
    setEntries(next);
  }, []);

  return (
    <div className="grid gap-4 px-6 py-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="grid gap-1">
          <span className="text-[11px] uppercase tracking-wide text-[color:var(--color-text-mute)]">
            On-device · Never syncs
          </span>
          <h1 className="m-0 text-2xl font-semibold tracking-tight text-white">
            History
          </h1>
          <p className="m-0 text-sm text-[color:var(--color-text-soft)]">
            {entries.length === 0
              ? "Your last 500 transcripts will live here once you start dictating."
              : `${entries.length} ${entries.length === 1 ? "transcript" : "transcripts"} saved on this device`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            className="btn btn-ghost px-2.5 py-1.5 text-xs"
            type="button"
            onClick={onBack}
          >
            <Mic size={13} />
            Back to dictate
          </button>
          {entries.length > 0 ? (
            confirmClear ? (
              <div className="flex items-center gap-1">
                <button
                  className="btn btn-secondary px-2.5 py-1.5 text-xs"
                  type="button"
                  onClick={() => setConfirmClear(false)}
                >
                  Cancel
                </button>
                <button
                  className="btn btn-danger px-2.5 py-1.5 text-xs"
                  type="button"
                  onClick={() => void handleClear()}
                >
                  <Trash2 size={13} />
                  Confirm clear
                </button>
              </div>
            ) : (
              <button
                className="btn btn-ghost px-2.5 py-1.5 text-xs"
                type="button"
                onClick={() => setConfirmClear(true)}
              >
                <Trash2 size={13} />
                Clear all
              </button>
            )
          ) : null}
        </div>
      </header>

      <div className="relative">
        <Search
          size={14}
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[color:var(--color-text-mute)]"
        />
        <input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search transcripts"
          aria-label="Search transcripts"
          className="form-input pl-9"
          disabled={entries.length === 0}
        />
      </div>

      {!hydrated ? (
        <HistorySkeleton />
      ) : filtered.length === 0 ? (
        entries.length === 0 ? (
          <HistoryEmpty />
        ) : (
          <HistoryNoMatches query={search} onClear={() => setSearch("")} />
        )
      ) : (
        <ol className="grid gap-2">
          {filtered.map((entry) => (
            <li key={entry.id}>
              <HistoryEntryCard
                entry={entry}
                pendingDelete={pendingDeleteId === entry.id}
                onCopy={() => handleCopy(entry)}
                onDelete={() => void handleDelete(entry.id)}
              />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function HistoryEntryCard({
  entry,
  pendingDelete,
  onCopy,
  onDelete
}: {
  entry: HistoryEntry;
  pendingDelete: boolean;
  onCopy: () => void;
  onDelete: () => void;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1400);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const text = entry.cleanedText || entry.text;
  const wordCount =
    entry.wordCount || (text ? text.split(/\s+/).filter(Boolean).length : 0);
  const seconds = Math.max(0, Math.round((entry.durationMs || 0) / 1000));
  const relative = formatRelativeTime(entry.createdAt);
  const absolute = formatAbsoluteTime(entry.createdAt);

  return (
    <article className="panel-soft group grid gap-2.5 p-4 transition-colors duration-150 hover:bg-[color:var(--color-surface)]">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-[color:var(--color-text-mute)]">
          <time
            className="font-semibold uppercase tracking-wide text-[color:var(--color-text-soft)]"
            dateTime={entry.createdAt}
            title={absolute}
          >
            {relative}
          </time>
          <span>·</span>
          <span>{seconds}s</span>
          <span>·</span>
          <span>
            {wordCount} {wordCount === 1 ? "word" : "words"}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="icon-btn-sm"
            onClick={onCopy}
            aria-label="Copy transcript"
            title={copied ? "Copied!" : "Copy transcript"}
          >
            {copied ? (
              <CheckCircle2 size={14} className="text-[color:var(--color-good)]" />
            ) : (
              <ClipboardCopy size={14} />
            )}
          </button>
          <button
            type="button"
            className="icon-btn-sm icon-btn-close"
            onClick={onDelete}
            disabled={pendingDelete}
            aria-label="Delete transcript"
            title="Delete transcript"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </header>

      <p className="m-0 text-sm leading-6 text-[color:var(--color-text)]">
        {text}
      </p>

      <footer className="flex flex-wrap items-center gap-1.5">
        <span
          className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
            entry.cleanupApplied
              ? "bg-[color:var(--color-brand-soft)] text-[color:var(--color-brand)]"
              : "bg-white/5 text-[color:var(--color-text-soft)]"
          }`}
        >
          {entry.cleanupApplied ? "Cleaned" : "Raw"}
        </span>
        <span className="rounded-full bg-white/5 px-2 py-0.5 text-[11px] text-[color:var(--color-text-soft)]">
          {entry.cleanupModel ?? "No cleanup"}
        </span>
        {entry.fallbackUsed ? (
          <span className="rounded-full bg-[color:var(--color-warn)]/15 px-2 py-0.5 text-[11px] text-[color:var(--color-warn)]">
            Fallback used
          </span>
        ) : null}
        {entry.transcriptionModel ? (
          <span className="rounded-full bg-white/5 px-2 py-0.5 text-[11px] text-[color:var(--color-text-mute)]">
            {entry.transcriptionModel}
          </span>
        ) : null}
      </footer>
    </article>
  );
}

function HistoryEmpty() {
  return (
    <div className="panel-soft grid place-items-center gap-3 p-10 text-center">
      <span className="grid size-10 place-items-center rounded-full bg-[color:var(--color-brand-soft)] text-[color:var(--color-brand)]">
        <Mic size={18} />
      </span>
      <div className="grid gap-1">
        <h3 className="m-0 text-base font-semibold text-white">No transcripts yet</h3>
        <p className="m-0 max-w-[52ch] text-pretty text-sm text-[color:var(--color-text-soft)]">
          Hold the dictation hotkey and speak. Each transcript is saved here on this
          device only — nothing leaves your machine.
        </p>
      </div>
    </div>
  );
}

function HistoryNoMatches({
  query,
  onClear
}: {
  query: string;
  onClear: () => void;
}) {
  return (
    <div className="panel-soft grid place-items-center gap-3 p-8 text-center">
      <h3 className="m-0 text-base font-semibold text-white">
        No transcripts match &ldquo;{query}&rdquo;
      </h3>
      <button className="btn btn-ghost px-3 py-1.5 text-xs" type="button" onClick={onClear}>
        Clear search
      </button>
    </div>
  );
}

function HistorySkeleton() {
  return (
    <div className="grid gap-2">
      {Array.from({ length: 3 }, (_, index) => (
        <div key={index} className="panel-soft grid gap-2 p-4">
          <div className="h-3 w-32 animate-pulse rounded-full bg-white/5" />
          <div className="h-3 w-full animate-pulse rounded-full bg-white/5" />
          <div className="h-3 w-3/4 animate-pulse rounded-full bg-white/5" />
        </div>
      ))}
    </div>
  );
}

function SettingsDrawer({
  status,
  hotkey,
  cleanupTier,
  audioInputs,
  selectedAudioInputId,
  deviceLoginError,
  hotkeyError,
  recordingControlsDisabled,
  onClose,
  onSelectCleanupTier,
  onSelectAudioInput,
  onRefreshInputs,
  onCheckWorker,
  onSetHotkey,
  onStartLogin,
  onLogout
}: {
  status: DesktopStatus;
  hotkey: string;
  cleanupTier: CleanupTier;
  audioInputs: MediaDeviceInfo[];
  selectedAudioInputId: string;
  deviceLoginError: string;
  hotkeyError: string;
  recordingControlsDisabled: boolean;
  onClose: () => void;
  onSelectCleanupTier: (tier: CleanupTier) => void;
  onSelectAudioInput: (deviceId: string) => void;
  onRefreshInputs: () => void;
  onCheckWorker: () => void;
  onSetHotkey: (hotkey: string) => Promise<void>;
  onStartLogin: () => Promise<void>;
  onLogout: () => Promise<void>;
}) {
  return (
    <div
      className="fixed inset-0 z-20 grid bg-black/55 backdrop-blur-sm"
      style={{ justifyItems: "end" }}
      role="presentation"
      onMouseDown={onClose}
    >
      <aside
        className="scroll-soft app-no-drag flex h-full w-[min(420px,92vw)] flex-col gap-5 overflow-auto border-l border-[color:var(--color-line)] bg-[color:var(--color-canvas-soft)] p-5"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-3 border-b border-[color:var(--color-line)] pb-4">
          <div className="grid gap-1">
            <span className="text-[11px] uppercase tracking-wide text-[color:var(--color-text-mute)]">
              Settings
            </span>
            <h2 className="m-0 text-lg font-semibold tracking-tight text-white">
              Dictation preferences
            </h2>
          </div>
          <button className="icon-btn" aria-label="Close settings" onClick={onClose}>
            <X size={16} />
          </button>
        </header>

        <SectionAccount
          status={status}
          deviceLoginError={deviceLoginError}
          onStartLogin={onStartLogin}
          onLogout={onLogout}
        />

        <SectionMicrophone
          audioInputs={audioInputs}
          selectedAudioInputId={selectedAudioInputId}
          recordingControlsDisabled={recordingControlsDisabled}
          onSelectAudioInput={onSelectAudioInput}
          onRefreshInputs={onRefreshInputs}
        />

        <SectionCleanup
          cleanupTier={cleanupTier}
          recordingControlsDisabled={recordingControlsDisabled}
          onSelectCleanupTier={onSelectCleanupTier}
        />

        <SectionHotkey
          hotkey={hotkey}
          rawHotkey={status.hotkey}
          error={hotkeyError}
          recordingControlsDisabled={recordingControlsDisabled}
          onSetHotkey={onSetHotkey}
        />

        <SectionWorker status={status} hotkey={hotkey} onCheckWorker={onCheckWorker} />
      </aside>
    </div>
  );
}

function SectionHotkey({
  hotkey,
  rawHotkey,
  error,
  recordingControlsDisabled,
  onSetHotkey
}: {
  hotkey: string;
  rawHotkey: string;
  error: string;
  recordingControlsDisabled: boolean;
  onSetHotkey: (hotkey: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState(rawHotkey);

  useEffect(() => {
    setDraft(rawHotkey);
  }, [rawHotkey]);

  const unchanged = normalizeHotkeyDraft(draft) === normalizeHotkeyDraft(rawHotkey);

  return (
    <section className="grid gap-3">
      <SectionIntro
        title="Hotkey"
        caption="Enter a hold shortcut with at least one modifier. Modifier-only shortcuts need two modifiers."
      />
      <div className="grid gap-2">
        <label className="text-xs font-medium text-[color:var(--color-text-soft)]" htmlFor="hotkey-input">
          Hold shortcut
        </label>
        <input
          id="hotkey-input"
          className="form-input"
          value={draft}
          disabled={recordingControlsDisabled}
          placeholder="Ctrl+Alt+Space"
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !unchanged) {
              void onSetHotkey(draft);
            }
          }}
        />
        <div className="flex items-center justify-between gap-2">
          <small className="truncate text-xs text-[color:var(--color-text-mute)]" title={hotkey}>
            Active: {hotkey}
          </small>
          <button
            className="btn btn-secondary px-2.5 py-1.5 text-xs"
            type="button"
            disabled={recordingControlsDisabled || unchanged}
            onClick={() => void onSetHotkey(draft)}
          >
            <KeyRound size={13} />
            Save
          </button>
        </div>
        {error ? <p className="m-0 text-xs text-[color:var(--color-warn)]">{error}</p> : null}
      </div>
    </section>
  );
}

function SectionAccount({
  status,
  deviceLoginError,
  onStartLogin,
  onLogout
}: {
  status: DesktopStatus;
  deviceLoginError: string;
  onStartLogin: () => Promise<void>;
  onLogout: () => Promise<void>;
}) {
  const headline = accountHeadline(status);
  const caption = accountCaption(status);
  const billingLabel = status.billing?.proActive ? "Laryn Pro active" : billingStatusLabel(status);
  const credit = usageCreditView(status);

  return (
    <section className="grid gap-3">
      <SectionIntro title="Account" caption={caption} />

      <div className="panel-soft grid gap-3 p-3.5">
        <div className="flex items-center gap-3">
          <span
            className={`grid size-9 place-items-center rounded-full ${
              status.authStatus === "ok"
                ? "bg-[color:var(--color-good)]/16 text-[color:var(--color-good)]"
                : "bg-[color:var(--color-bad)]/16 text-[color:var(--color-bad)]"
            }`}
          >
            <UserRound size={16} />
          </span>
          <div className="min-w-0 grid leading-tight">
            <strong className="truncate text-[13px] font-semibold text-white">
              {status.account?.email || headline}
            </strong>
            <small className="mt-0.5 truncate text-xs text-[color:var(--color-text-mute)]">
              {billingLabel}
            </small>
          </div>
        </div>

        {status.deviceLogin ? (
          <div className="rounded-xl border border-dashed border-[color:var(--color-brand)]/40 bg-[color:var(--color-brand-soft)] p-3">
            <span className="block text-[10px] font-bold uppercase tracking-[0.16em] text-[color:var(--color-brand)]">
              Device code
            </span>
            <strong className="mt-1.5 block text-2xl font-bold tracking-[0.16em] text-white tabular-nums">
              {status.deviceLogin.userCode}
            </strong>
            <small className="mt-1.5 block text-xs leading-snug text-[color:var(--color-text-soft)]">
              Approve this code in the browser window that opened.
            </small>
          </div>
        ) : null}

        {deviceLoginError ? (
          <p className="m-0 text-xs text-[color:var(--color-warn)]">{deviceLoginError}</p>
        ) : null}

        {credit ? (
          <div className="rounded-xl bg-black/20 p-3 shadow-[inset_0_0_0_1px_var(--color-line)]">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <span className="block text-[10px] font-bold uppercase tracking-[0.16em] text-[color:var(--color-text-mute)]">
                  Usage credit
                </span>
                <strong className={`mt-1 block truncate text-[15px] font-semibold ${credit.toneClass}`}>
                  {credit.headline}
                </strong>
              </div>
              <span className="rounded-full bg-white/[0.06] px-2 py-1 text-[11px] font-medium text-[color:var(--color-text-soft)]">
                {credit.includedLabel}
              </span>
            </div>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/[0.06]">
              <span
                className={`block h-full rounded-full ${credit.barClass}`}
                style={{ width: `${credit.percent}%` }}
              />
            </div>
            <p className="m-0 mt-2 text-xs leading-snug text-[color:var(--color-text-mute)]">
              {credit.caption}
            </p>
          </div>
        ) : null}

        <div className="grid gap-2">
          {status.authStatus === "signed-out" || status.authStatus === "unauthorized" ? (
            <button
              className="btn btn-secondary w-full"
              type="button"
              onClick={() => void onStartLogin()}
            >
              <KeyRound size={14} />
              Sign in with Google
            </button>
          ) : null}
          {status.authStatus === "pending" ? (
            <button
              className="btn btn-secondary w-full"
              type="button"
              onClick={() => void window.laryn.openAccount()}
            >
              <ExternalLink size={14} />
              Open approval page
            </button>
          ) : null}
          {status.authStatus === "subscription-required" ? (
            <button
              className="btn btn-primary w-full"
              type="button"
              onClick={() => void window.laryn.openAccount()}
            >
              <ExternalLink size={14} />
              Manage subscription
            </button>
          ) : null}
          {status.authStatus === "ok" ? (
            <button
              className="btn btn-secondary w-full"
              type="button"
              onClick={() => void window.laryn.openAccount()}
            >
              <ExternalLink size={14} />
              Open account
            </button>
          ) : null}
          {status.authStatus !== "signed-out" ? (
            <button
              className="btn btn-ghost w-full"
              type="button"
              onClick={() => void onLogout()}
            >
              <LogOut size={14} />
              Sign out
            </button>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function SectionMicrophone({
  audioInputs,
  selectedAudioInputId,
  recordingControlsDisabled,
  onSelectAudioInput,
  onRefreshInputs
}: {
  audioInputs: MediaDeviceInfo[];
  selectedAudioInputId: string;
  recordingControlsDisabled: boolean;
  onSelectAudioInput: (deviceId: string) => void;
  onRefreshInputs: () => void;
}) {
  return (
    <section className="grid gap-3">
      <SectionIntro
        title="Microphone"
        caption="Select the input Laryn should use when you hold the hotkey."
      />
      <div className="grid gap-2">
        <label className="text-xs font-medium text-[color:var(--color-text-soft)]" htmlFor="audio-input">
          Input device
        </label>
        <select
          id="audio-input"
          className="form-select"
          value={selectedAudioInputId}
          disabled={recordingControlsDisabled}
          onChange={(event) => onSelectAudioInput(event.target.value)}
        >
          <option value="">System default</option>
          {audioInputs.map((device, index) => (
            <option key={device.deviceId || `input-${index}`} value={device.deviceId}>
              {audioInputLabel(device, device.deviceId, index)}
            </option>
          ))}
        </select>
        <button
          className="btn btn-secondary w-full"
          type="button"
          onClick={onRefreshInputs}
          disabled={recordingControlsDisabled}
        >
          <RefreshCw size={14} />
          Refresh inputs
        </button>
      </div>
    </section>
  );
}

function SectionCleanup({
  cleanupTier,
  recordingControlsDisabled,
  onSelectCleanupTier
}: {
  cleanupTier: CleanupTier;
  recordingControlsDisabled: boolean;
  onSelectCleanupTier: (tier: CleanupTier) => void;
}) {
  const tiers: CleanupTier[] = ["off", "cheap", "standard", "premium"];
  return (
    <section className="grid gap-3">
      <SectionIntro
        title="Cleanup quality"
        caption="Choose how aggressively Laryn cleans punctuation and dictation artifacts before pasting."
      />
      <div className="grid gap-2" role="radiogroup" aria-label="Cleanup quality">
        {tiers.map((tier) => (
          <button
            key={tier}
            type="button"
            role="radio"
            aria-checked={cleanupTier === tier}
            disabled={recordingControlsDisabled}
            data-active={cleanupTier === tier}
            className="tier-option"
            onClick={() => onSelectCleanupTier(tier)}
          >
            <span className="grid leading-tight">
              <strong className="text-sm font-semibold text-white">
                {tierLabel(tier)}
              </strong>
              <small className="mt-0.5 text-xs text-[color:var(--color-text-mute)]">
                {cleanupModelLabel(tier)}
              </small>
            </span>
            {cleanupTier === tier ? (
              <CheckCircle2 size={18} className="text-[color:var(--color-brand)]" />
            ) : null}
          </button>
        ))}
      </div>
    </section>
  );
}

function SectionWorker({
  status,
  hotkey,
  onCheckWorker
}: {
  status: DesktopStatus;
  hotkey: string;
  onCheckWorker: () => void;
}) {
  return (
    <section className="grid gap-3">
      <SectionIntro
        title="Worker"
        caption="Endpoint Laryn uses for transcription and cleanup."
      />
      <div className="panel-soft grid divide-y divide-[color:var(--color-line)] overflow-hidden">
        <DefinitionRow label="URL" value={status.workerUrl} mono />
        <DefinitionRow
          label="Status"
          value={status.workerStatus}
          tone={status.workerStatus === "online" ? "good" : "warn"}
        />
        <DefinitionRow label="Hotkey" value={hotkey} />
      </div>
      <button
        className="btn btn-secondary w-full"
        type="button"
        onClick={onCheckWorker}
      >
        <RefreshCw size={14} />
        Check connection
      </button>
    </section>
  );
}

function DefinitionRow({
  label,
  value,
  mono = false,
  tone
}: {
  label: string;
  value: string;
  mono?: boolean;
  tone?: "good" | "warn";
}) {
  return (
    <div className="grid grid-cols-[80px_minmax(0,1fr)] items-center gap-3 px-3.5 py-2.5">
      <dt className="text-xs uppercase tracking-wide text-[color:var(--color-text-mute)]">
        {label}
      </dt>
      <dd className="m-0 flex items-center gap-2 truncate" title={value}>
        {tone ? (
          <span
            className={`dot ${tone === "good" ? "dot-good" : "dot-warn"}`}
            aria-hidden="true"
          />
        ) : null}
        <span
          className={`truncate text-sm ${
            mono ? "font-mono text-[color:var(--color-text-soft)]" : "font-medium text-white"
          }`}
        >
          {value}
        </span>
      </dd>
    </div>
  );
}

function SectionIntro({ title, caption }: { title: string; caption?: string }) {
  return (
    <div className="grid gap-1">
      <h3 className="m-0 text-[15px] font-semibold tracking-tight text-white">{title}</h3>
      {caption ? (
        <p className="m-0 max-w-[56ch] text-pretty text-xs leading-snug text-[color:var(--color-text-mute)]">
          {caption}
        </p>
      ) : null}
    </div>
  );
}

function splitHotkey(hotkey: string): string[] {
  return hotkey
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function normalizeHotkeyDraft(hotkey: string): string {
  return hotkey.replace(/\s+/g, "").toLowerCase();
}

function accountHeadline(status: DesktopStatus): string {
  if (status.authStatus === "pending") return "Approval pending";
  if (status.authStatus === "subscription-required") return "Pro required";
  if (status.authStatus === "unauthorized") return "Sign in again";
  if (status.authStatus === "ok") return "Connected";
  return "Not signed in";
}

function accountCaption(status: DesktopStatus): string {
  if (status.authStatus === "ok") return "This desktop is paired and ready to transcribe.";
  if (status.authStatus === "pending") return "Finish approving this desktop from your Laryn account page.";
  if (status.authStatus === "subscription-required")
    return "Your account is paired, but transcription needs an active Laryn Pro subscription.";
  return "Pair this desktop with your Google account to use Laryn Pro.";
}

function billingStatusLabel(status: DesktopStatus): string {
  if (status.authStatus === "subscription-required") return "Subscription required";
  if (status.authStatus === "pending") return "Waiting for approval";
  if (status.authStatus === "unauthorized") return "Token revoked or expired";
  return status.billing?.subscriptionStatus || status.authStatus;
}

function usageCreditView(status: DesktopStatus):
  | {
      headline: string;
      caption: string;
      includedLabel: string;
      percent: number;
      barClass: string;
      toneClass: string;
    }
  | null {
  const credits = status.billing?.usageCredits;
  if (!credits) return null;

  const includedCents = credits.includedCents || 300;
  const includedLabel = `${formatCurrencyFromCents(includedCents)} included`;
  const consumedCents = credits.consumedCents || 0;
  const consumedUnits = credits.consumedUnits ?? 0;
  const creditedUnits = credits.creditedUnits ?? credits.includedUnits;
  const percent = creditedUnits > 0 ? Math.min(100, Math.max(0, (consumedUnits / creditedUnits) * 100)) : 0;

  if (typeof credits.overageCents === "number" && credits.overageCents > 0) {
    return {
      headline: `${formatCurrencyFromCents(consumedCents)} used of ${formatCurrencyFromCents(includedCents)}`,
      caption: `${formatCurrencyFromCents(credits.overageCents)} estimated overage is billed through Polar.`,
      includedLabel,
      percent: 100,
      barClass: "bg-[color:var(--color-warn)]",
      toneClass: "text-[color:var(--color-warn)]"
    };
  }

  if (typeof credits.remainingCents === "number") {
    return {
      headline: `${formatCurrencyFromCents(consumedCents)} used of ${formatCurrencyFromCents(includedCents)}`,
      caption: `${formatCurrencyFromCents(credits.remainingCents)} remaining. Usage refreshes from Polar after transcription.`,
      includedLabel,
      percent,
      barClass: "bg-[color:var(--color-good)]",
      toneClass: "text-white"
    };
  }

  return {
    headline: `${formatCurrencyFromCents(consumedCents)} used of ${formatCurrencyFromCents(includedCents)}`,
    caption: "Credit balance appears here after Polar reports meter usage for this account.",
    includedLabel,
    percent: 0,
    barClass: "bg-[color:var(--color-brand)]",
    toneClass: "text-white"
  };
}

function formatCurrencyFromCents(cents: number): string {
  return `$${(Math.max(0, cents) / 100).toFixed(2)}`;
}

const RELATIVE_UNITS: Array<{ unit: Intl.RelativeTimeFormatUnit; ms: number }> = [
  { unit: "year", ms: 1000 * 60 * 60 * 24 * 365 },
  { unit: "month", ms: 1000 * 60 * 60 * 24 * 30 },
  { unit: "week", ms: 1000 * 60 * 60 * 24 * 7 },
  { unit: "day", ms: 1000 * 60 * 60 * 24 },
  { unit: "hour", ms: 1000 * 60 * 60 },
  { unit: "minute", ms: 1000 * 60 },
  { unit: "second", ms: 1000 }
];

const relativeFormatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const absoluteFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short"
});

function formatRelativeTime(iso: string): string {
  const target = Date.parse(iso);
  if (Number.isNaN(target)) return "";
  const diff = target - Date.now();
  for (const { unit, ms } of RELATIVE_UNITS) {
    if (Math.abs(diff) >= ms || unit === "second") {
      return relativeFormatter.format(Math.round(diff / ms), unit);
    }
  }
  return "just now";
}

function formatAbsoluteTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return absoluteFormatter.format(date);
}
