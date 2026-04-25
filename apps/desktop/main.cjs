const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, clipboard, nativeImage, Notification } = require("electron");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const path = require("node:path");
const { uIOhook, UiohookKey } = require("uiohook-napi");
const { loadConfig, normalizeCleanupTier } = require("./config.cjs");

const execFileAsync = promisify(execFile);
const config = loadConfig(__dirname);

let mainWindow = null;
let tray = null;
let activeHotkey = config.hotkey;
let shouldQuit = false;
let cleanupTier = config.cleanupTier;
let nativeHookReady = false;

const hotkeyState = {
  ctrlDown: false,
  winDown: false,
  recordingRequested: false,
  recordingActive: false,
  lastEventAt: null,
  lastStopAt: 0
};

const status = {
  authStatus: config.desktopToken ? "unknown" : "missing-token",
  hotkey: activeHotkey,
  hotkeyStatus: {
    activeHotkey,
    mode: "error"
  },
  isRecording: false,
  workerStatus: "unknown",
  workerUrl: config.workerUrl,
  state: "idle",
  message: config.desktopToken ? "Checking Worker" : "Desktop auth token missing"
};

app.setName("Laryn");
Menu.setApplicationMenu(null);

app.whenReady().then(() => {
  createWindow();
  createTray();
  registerNativeHotkey();
  registerIpc();
  void refreshWorkerAuth();
});

app.on("window-all-closed", () => undefined);

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  if (nativeHookReady) {
    uIOhook.stop();
  }
});

function createWindow() {
  const window = new BrowserWindow({
    width: 520,
    height: 720,
    show: true,
    resizable: false,
    title: "Laryn",
    backgroundColor: "#101310",
    webPreferences: {
      preload: path.join(__dirname, "dist-electron", "preload.mjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow = window;
  const rendererUrl = config.rendererUrl;
  if (rendererUrl) {
    void window.loadURL(rendererUrl);
  } else {
    void window.loadFile(path.join(__dirname, "dist", "renderer", "index.html"));
  }

  window.on("close", (event) => {
    if (!shouldQuit) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
}

function createTray() {
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip("Laryn");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Show Laryn", click: () => mainWindow?.show() },
      { label: "Toggle recording", click: toggleRecording },
      { type: "separator" },
      {
        label: "Quit",
        click: () => {
          shouldQuit = true;
          app.quit();
        }
      }
    ])
  );
}

function registerNativeHotkey() {
  try {
    uIOhook.on("keydown", (event) => {
      updateModifierState(event);
      status.hotkeyStatus.lastEventAt = new Date().toISOString();
      if (isCtrlWinPressed() && !hotkeyState.recordingRequested && Date.now() - hotkeyState.lastStopAt > 250) {
        startRecording();
      }
    });
    uIOhook.on("keyup", (event) => {
      updateModifierState(event);
      status.hotkeyStatus.lastEventAt = new Date().toISOString();
      if (hotkeyState.recordingRequested && !isCtrlWinPressed()) {
        stopRecording();
      }
    });
    uIOhook.start();
    nativeHookReady = true;
    activeHotkey = "Ctrl+Win";
    patchStatus({
      hotkey: activeHotkey,
      hotkeyStatus: {
        activeHotkey,
        mode: "native-hold"
      },
      state: "idle",
      message: `Hold ${displayHotkey(activeHotkey)} to dictate`
    });
  } catch (error) {
    registerHotkeyFallback(error);
  }
}

function registerHotkeyFallback(error) {
  const candidates = ["CommandOrControl+Alt+Space"];
  const registered = candidates.find((candidate) => tryRegisterHotkey(candidate));

  activeHotkey = registered || "unregistered";
  patchStatus({
    hotkey: activeHotkey,
    hotkeyStatus: {
      activeHotkey,
      error: error instanceof Error ? error.message : String(error),
      mode: registered ? "electron-toggle-fallback" : "error"
    },
    state: registered ? "idle" : "error",
    message: registered
      ? `Native key hook failed; using ${displayHotkey(activeHotkey)}`
      : `Could not register a global hotkey${error instanceof Error ? `: ${error.message}` : ""}`
  });
}

function registerIpc() {
  ipcMain.handle("renderer:ready", () => status);
  ipcMain.handle("worker:check", refreshWorkerAuth);
  ipcMain.on("recording:started", () => {
    hotkeyState.recordingActive = true;
    hotkeyState.recordingRequested = true;
    patchStatus({ isRecording: true, state: "recording", message: "Recording" });
  });
  ipcMain.on("recording:stopped", () => {
    hotkeyState.recordingActive = false;
    hotkeyState.recordingRequested = false;
    hotkeyState.lastStopAt = Date.now();
    patchStatus({ isRecording: false, state: "transcribing", message: "Transcribing" });
  });
  ipcMain.handle("transcription:submit", async (_event, audio, mimeType, durationMs, requestedCleanupTier) => {
    cleanupTier = normalizeCleanupTier(requestedCleanupTier || cleanupTier);
    const result = await transcribe(audio, mimeType, durationMs, cleanupTier);
    if (result.text) {
      patchStatus({ state: "pasting", message: "Pasting transcript", lastTranscript: result });
      await pasteText(result.text);
      patchStatus({ state: "idle", message: "Ready", lastTranscript: result });
    } else {
      patchStatus({ state: "idle", message: "No speech detected" });
    }
    return result;
  });
}

function toggleRecording() {
  if (hotkeyState.recordingRequested || hotkeyState.recordingActive) {
    stopRecording();
    return;
  }

  startRecording();
}

function startRecording() {
  if (!mainWindow || hotkeyState.recordingRequested) {
    return;
  }

  if (!canRecord()) {
    patchStatus({
      state: "error",
      message: workerAuthMessage()
    });
    return;
  }

  hotkeyState.recordingRequested = true;
  mainWindow.webContents.send("recording:start");
}

function stopRecording() {
  if (!mainWindow || !hotkeyState.recordingRequested) {
    return;
  }

  hotkeyState.recordingRequested = false;
  hotkeyState.lastStopAt = Date.now();
  mainWindow.webContents.send("recording:stop");
}

async function transcribe(audio, mimeType, durationMs, selectedCleanupTier) {
  if (!canRecord()) {
    await refreshWorkerAuth();
  }

  if (!canRecord()) {
    const message = workerAuthMessage();
    patchStatus({ state: "error", message });
    throw new Error(message);
  }

  const form = new FormData();
  form.append("audio", new Blob([audio], { type: mimeType }), `laryn-${Date.now()}.webm`);
  form.append("durationMs", String(durationMs));
  form.append("cleanupTier", selectedCleanupTier);

  const response = await fetch(`${config.workerUrl}/v1/transcriptions`, {
    method: "POST",
    headers: authHeaders(),
    body: form
  });

  const payload = await readJsonResponse(response);
  if (!response.ok || "error" in payload) {
    const message = "error" in payload ? payload.detail || payload.error : `HTTP ${response.status}`;
    patchStatus({ state: "error", message });
    throw new Error(message);
  }

  return payload;
}

async function pasteText(text) {
  clipboard.writeText(text);
  await execFileAsync("powershell.exe", [
    "-NoProfile",
    "-Command",
    "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')"
  ]);
}

function patchStatus(next) {
  Object.assign(status, next);
  mainWindow?.webContents.send("desktop:status", status);

  if (next.state === "error" && Notification.isSupported()) {
    new Notification({ title: "Laryn", body: status.message }).show();
  }
}

async function refreshWorkerAuth() {
  if (!config.desktopToken) {
    patchStatus({
      authStatus: "missing-token",
      workerStatus: "unknown",
      message: "Desktop auth token missing"
    });
    return status;
  }

  try {
    const health = await fetch(`${config.workerUrl}/health`);
    if (!health.ok) {
      patchStatus({
        authStatus: "unknown",
        workerStatus: "offline",
        message: `Worker health failed at ${config.workerUrl}`
      });
      return status;
    }
  } catch {
    patchStatus({
      authStatus: "unknown",
      workerStatus: "offline",
      message: `Worker offline at ${config.workerUrl}`
    });
    return status;
  }

  try {
    const response = await fetch(`${config.workerUrl}/health/auth`, {
      headers: authHeaders()
    });
    if (response.status === 401) {
      patchStatus({
        authStatus: "unauthorized",
        workerStatus: "unauthorized",
        state: "error",
        message: workerAuthMessage()
      });
      return status;
    }

    if (!response.ok) {
      patchStatus({
        authStatus: "unknown",
        workerStatus: "offline",
        message: `Worker auth check failed at ${config.workerUrl}`
      });
      return status;
    }

    patchStatus({
      authStatus: "ok",
      workerStatus: "online",
      state: "idle",
      message: `Worker online at ${config.workerUrl}`
    });
  } catch {
    patchStatus({
      authStatus: "unknown",
      workerStatus: "offline",
      message: `Worker auth check failed at ${config.workerUrl}`
    });
  }

  return status;
}

async function readJsonResponse(response) {
  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();

  if (!contentType.includes("application/json")) {
    const snippet = text.replace(/\s+/g, " ").trim().slice(0, 220);
    return {
      error: `Expected JSON from ${response.url || config.workerUrl}, received ${contentType || "unknown content type"}`,
      detail: snippet || `HTTP ${response.status}`
    };
  }

  try {
    return text ? JSON.parse(text) : {};
  } catch (error) {
    return {
      error: `Invalid JSON from ${response.url || config.workerUrl}`,
      detail: error instanceof Error ? error.message : String(error)
    };
  }
}

function authHeaders() {
  return config.desktopToken ? { authorization: `Bearer ${config.desktopToken}` } : undefined;
}

function canRecord() {
  return status.workerStatus === "online" && status.authStatus === "ok";
}

function workerAuthMessage() {
  if (!config.desktopToken) {
    return "Desktop auth token missing";
  }

  if (status.authStatus === "unauthorized" || status.workerStatus === "unauthorized") {
    return `Worker auth failed for ${config.workerUrl}. Check LARYN_DESKTOP_TOKEN and Worker port.`;
  }

  return `Worker unavailable at ${config.workerUrl}. Check the Worker dev server and port.`;
}

function displayHotkey(hotkey) {
  return hotkey.replace("Control", "Ctrl").replace("Super", "Win").replaceAll("+", " + ");
}

function tryRegisterHotkey(candidate) {
  try {
    return globalShortcut.register(candidate, toggleRecording);
  } catch {
    return false;
  }
}

function isCtrlWinPressed() {
  return hotkeyState.ctrlDown && hotkeyState.winDown;
}

function updateModifierState(event) {
  const isCtrlCode = event.keycode === UiohookKey.Ctrl || event.keycode === UiohookKey.CtrlRight;
  const isMetaCode = event.keycode === UiohookKey.Meta || event.keycode === UiohookKey.MetaRight;
  hotkeyState.ctrlDown = event.ctrlKey || (event.type === 4 && isCtrlCode);
  hotkeyState.winDown = event.metaKey || (event.type === 4 && isMetaCode);
  hotkeyState.lastEventAt = Date.now();
}
