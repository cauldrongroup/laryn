import { execFile as S } from "node:child_process";
import { promisify as C } from "node:util";
import N from "electron";
const k = C(S), {
  app: c,
  BrowserWindow: v,
  Tray: A,
  Menu: E,
  globalShortcut: R,
  ipcMain: l,
  clipboard: _,
  nativeImage: O,
  Notification: w
} = N;
let t = null, m = null, y = !1, d = process.env.LARYN_HOTKEY ?? "Control+Super", T = !1, h = L(process.env.LARYN_CLEANUP_TIER);
const p = {
  hotkey: d,
  isRecording: !1,
  state: "idle",
  message: "Ready"
};
c.setName("Laryn");
c.whenReady().then(async () => {
  x(), Y(), K(), P();
});
c.on("window-all-closed", () => {
});
c.on("will-quit", () => {
  R.unregisterAll();
});
function x() {
  const e = new v({
    width: 520,
    height: 720,
    show: !0,
    resizable: !1,
    title: "Laryn",
    backgroundColor: "#101310",
    webPreferences: {
      preload: new URL("./preload.mjs", import.meta.url).pathname,
      contextIsolation: !0,
      nodeIntegration: !1
    }
  });
  t = e;
  const o = process.env.LARYN_RENDERER_URL;
  o ? e.loadURL(o) : e.loadFile(new URL("../dist/renderer/index.html", import.meta.url).pathname), e.on("close", (n) => {
    T || (n.preventDefault(), t == null || t.hide());
  });
}
function Y() {
  const e = O.createEmpty();
  m = new A(e), m.setToolTip("Laryn"), m.setContextMenu(
    E.buildFromTemplate([
      { label: "Show Laryn", click: () => t == null ? void 0 : t.show() },
      { label: "Toggle recording", click: b },
      { type: "separator" },
      {
        label: "Quit",
        click: () => {
          T = !0, c.quit();
        }
      }
    ])
  );
}
function K() {
  const n = [process.env.LARYN_HOTKEY ?? "Control+Super", "Control+Super+Space", "CommandOrControl+Alt+Space"].find((a) => D(a));
  d = n ?? "unregistered", s({
    hotkey: d,
    state: n ? "idle" : "error",
    message: n ? `Listening for ${H(d)}` : "Could not register a global hotkey"
  });
}
function P() {
  l.handle("renderer:ready", () => p), l.on("recording:started", () => {
    y = !0, s({ isRecording: !0, state: "recording", message: "Recording" });
  }), l.on("recording:stopped", () => {
    y = !1, s({ isRecording: !1, state: "transcribing", message: "Transcribing" });
  }), l.handle("transcription:submit", async (e, o, n, a, u) => {
    h = L(u);
    const r = await U(o, n, a, h);
    return r.text ? (s({ state: "pasting", message: "Pasting transcript", lastTranscript: r }), await F(r.text), s({ state: "idle", message: "Ready", lastTranscript: r })) : s({ state: "idle", message: "No speech detected" }), r;
  });
}
function b() {
  if (t) {
    if (y) {
      t.webContents.send("recording:stop");
      return;
    }
    t.webContents.send("recording:start");
  }
}
async function U(e, o, n, a) {
  const u = process.env.LARYN_WORKER_URL ?? "http://127.0.0.1:8787", r = new FormData();
  r.append("audio", new Blob([e], { type: o }), `laryn-${Date.now()}.webm`), r.append("durationMs", String(n)), r.append("cleanupTier", a);
  const g = await fetch(`${u.replace(/\/$/, "")}/v1/transcriptions`, {
    method: "POST",
    headers: process.env.LARYN_DESKTOP_TOKEN ? { authorization: `Bearer ${process.env.LARYN_DESKTOP_TOKEN}` } : void 0,
    body: r
  }), i = await g.json();
  if (!g.ok || "error" in i) {
    const f = "error" in i ? i.detail ?? i.error : `HTTP ${g.status}`;
    throw s({ state: "error", message: f }), new Error(f);
  }
  return i;
}
async function F(e) {
  _.writeText(e), await k("powershell.exe", [
    "-NoProfile",
    "-Command",
    "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')"
  ]);
}
function s(e) {
  Object.assign(p, e), t == null || t.webContents.send("desktop:status", p), e.state === "error" && w.isSupported() && new w({ title: "Laryn", body: p.message }).show();
}
function H(e) {
  return e.replace("Control", "Ctrl").replace("Super", "Win").replaceAll("+", " + ");
}
function D(e) {
  try {
    return R.register(e, b);
  } catch {
    return !1;
  }
}
function L(e) {
  return e === "cheap" || e === "premium" || e === "standard" ? e : "standard";
}
