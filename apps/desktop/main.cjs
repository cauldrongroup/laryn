const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, clipboard, nativeImage, Notification, shell, screen, safeStorage, session } = require("electron");
const { autoUpdater } = require("electron-updater");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const fs = require("node:fs");
const path = require("node:path");
const { EventType, uIOhook, UiohookKey } = require("uiohook-napi");
const { loadConfig, normalizeCleanupTier } = require("./config.cjs");
const { createBufferedLogSink } = require("./src/main/buffered-log-sink.cjs");
const { bindFirstRevealTrigger } = require("./src/main/window-reveal.cjs");

const execFileAsync = promisify(execFile);
const config = loadConfig(__dirname);
const packageInfo = loadPackageInfo(__dirname);

let mainWindow = null;
let dictationWindow = null;
let dictationWindowReady = false;
let tray = null;
let activeHotkey = config.hotkey;
let shouldQuit = false;
let cleanupTier = config.cleanupTier;
let nativeHookReady = false;
let logFilePath = null;
let logSink = null;
let authFilePath = null;
let historyFilePath = null;
let settingsFilePath = null;
let dictionaryFilePath = null;
let dictationRendererReady = false;
let dictationRendererReadyWaiters = [];
let statusBroadcastQueued = false;
let historyCache = null;
let dictionaryCache = null;
let desktopSettings = {
  hotkey: config.hotkey
};
let activeHotkeyBinding = null;
let updateCheckPromise = null;
let updateReadyToInstall = false;
let updateInstallRequested = false;
let workerAuthPollTimer = null;
let workerAuthPollInFlight = false;
let usageCreditRefreshTimers = [];
let desktopAuth = {
  token: "",
  account: null,
  billing: null
};
let authGeneration = 0;

const MAX_HISTORY_ENTRIES = 500;
const DICTIONARY_VERSION = 1;
const MAX_DICTIONARY_ENTRIES = 1000;
const MAX_DICTIONARY_SEND_ENTRIES = 200;
const MAX_DICTIONARY_PHRASE_LENGTH = 60;
const MAX_DICTIONARY_REPLACEMENT_LENGTH = 120;
const WORKER_AUTH_POLL_INTERVAL_MS = 5 * 60 * 1000;
const POST_TRANSCRIPTION_USAGE_REFRESH_DELAYS_MS = [5_000, 20_000, 60_000];
const DEFERRED_USAGE_REFRESH_RETRY_MS = 5_000;
const INSTALL_UPDATE_SILENTLY = true;
const RUN_AFTER_SILENT_UPDATE = true;

const hotkeyState = {
  ctrlDown: false,
  altDown: false,
  shiftDown: false,
  winDown: false,
  pressedKeyCodes: new Set(),
  recordingRequested: false,
  recordingActive: false,
  lastEventAt: null,
  lastStopAt: 0
};

const status = {
  appVersion: app.getVersion(),
  authStatus: "signed-out",
  hotkey: activeHotkey,
  hotkeyStatus: {
    activeHotkey,
    mode: "error"
  },
  isRecording: false,
  updateStatus: "idle",
  updateMessage: "Updates check automatically after startup",
  workerStatus: "unknown",
  workerUrl: config.workerUrl,
  releaseName: packageInfo.releaseName,
  state: "idle",
  message: "Sign in to connect Laryn"
};

const DICTATION_WINDOW_WIDTH = 800;
const DICTATION_WINDOW_HEIGHT = 120;
const DICTATION_BOTTOM_OFFSET = 56;
const APP_ICON_PATH = resolveAssetPath("logo.png");
const TRAY_ICON_PATH = resolveAssetPath("tray.png");

app.setName("Laryn");
if (process.platform === "win32") {
  app.setAppUserModelId("dev.laryn.desktop");
}
Menu.setApplicationMenu(null);

const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    logInfo("app:second-instance", {
      updateReady: isUpdateReadyToInstall(),
      updateInstallRequested
    });
    if (isUpdateReadyToInstall()) {
      installUpdateSafely("second-instance");
      return;
    }

    showMainWindow("second-instance");
  });

  app.whenReady().then(() => {
    configureLogging();
    loadDesktopSettings();
    loadDesktopAuth();
    loadDictionary();
    logInfo("app:ready", {
      workerUrl: config.workerUrl,
      rendererUrl: config.rendererUrl || "packaged",
      hasDesktopToken: Boolean(desktopAuth.token),
      cleanupTier,
      historyLoaded: false,
      dictionaryCount: dictionaryCache?.length ?? 0
    });
    configureMediaPermissions();
    registerIpc();
    createWindow();
    createTray();
    registerNativeHotkey();
    configureAutoUpdates();
    configureWorkerAuthPolling();
    void refreshWorkerAuth();
  });
}

app.on("window-all-closed", () => undefined);

app.on("before-quit", (event) => {
  if (!app.isPackaged || !isUpdateReadyToInstall() || updateInstallRequested) {
    return;
  }

  logInfo("updates:install-on-quit");
  event.preventDefault();
  installUpdateSafely("app-quit");
});

app.on("before-quit-for-update", () => {
  shouldQuit = true;
  updateInstallRequested = true;
  logInfo("updates:before-quit-for-update");
});

app.on("will-quit", () => {
  logInfo("app:will-quit");
  globalShortcut.unregisterAll();
  if (nativeHookReady) {
    uIOhook.stop();
  }
  logSink?.close();
  logSink = null;
  clearUsageCreditRefreshTimers();
  if (workerAuthPollTimer) {
    clearInterval(workerAuthPollTimer);
    workerAuthPollTimer = null;
  }
});

function createWindow() {
  const window = new BrowserWindow({
    width: 860,
    height: 560,
    show: false,
    resizable: false,
    title: "Laryn",
    icon: APP_ICON_PATH,
    frame: false,
    backgroundColor: "#06090f",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow = window;
  window.webContents.setWindowOpenHandler(({ url }) => {
    const externalUrl = getSafeExternalUrl(url);
    if (externalUrl) {
      void shell.openExternal(externalUrl);
    }
    return { action: "deny" };
  });

  void loadRendererInto(window, "main");

  const revealSubscribers = [(fire) => window.once("ready-to-show", fire)];
  if (process.platform === "linux") {
    revealSubscribers.push((fire) => window.webContents.once("did-finish-load", fire));
  }
  bindFirstRevealTrigger(revealSubscribers, () => {
    if (!window.isDestroyed()) {
      window.show();
    }
  });

  window.on("close", (event) => {
    if (!shouldQuit) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  window.on("show", () => {
    sendMainWindowSnapshot(window);
  });
}

function createDictationWindow() {
  const window = new BrowserWindow({
    width: DICTATION_WINDOW_WIDTH,
    height: DICTATION_WINDOW_HEIGHT,
    show: false,
    resizable: false,
    skipTaskbar: true,
    title: "Laryn Dictation",
    frame: false,
    transparent: true,
    hasShadow: false,
    focusable: false,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  });

  dictationWindow = window;
  dictationWindowReady = false;
  dictationRendererReady = false;
  window.webContents.setWindowOpenHandler(({ url }) => {
    const externalUrl = getSafeExternalUrl(url);
    if (externalUrl) {
      void shell.openExternal(externalUrl);
    }
    return { action: "deny" };
  });

  void loadRendererInto(window, "overlay");

  const readySubscribers = [(fire) => window.once("ready-to-show", fire)];
  if (process.platform === "linux") {
    readySubscribers.push((fire) => window.webContents.once("did-finish-load", fire));
  }
  bindFirstRevealTrigger(readySubscribers, () => {
    dictationWindowReady = true;
    logInfo("dictation:ready-to-show");
  });

  window.on("closed", () => {
    dictationWindow = null;
    dictationWindowReady = false;
    dictationRendererReady = false;
    resolveDictationRendererWaiters();
  });
}

function ensureDictationWindow() {
  if (!dictationWindow || dictationWindow.isDestroyed()) {
    createDictationWindow();
  }

  return dictationWindow;
}

function loadRendererInto(window, view) {
  const rendererUrl = config.rendererUrl;
  if (rendererUrl) {
    const url = new URL(rendererUrl);
    url.searchParams.set("view", view);
    return window.loadURL(url.toString());
  }

  return window.loadFile(path.join(__dirname, "..", "dist", "renderer", "index.html"), {
    search: `?view=${view}`
  });
}

function configureMediaPermissions() {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    if (permission !== "media") {
      callback(false);
      return;
    }

    const mediaTypes = Array.isArray(details?.mediaTypes) ? details.mediaTypes : [];
    callback(mediaTypes.includes("audio") && isTrustedRenderer(webContents));
  });

  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    if (permission !== "media") {
      return false;
    }

    const mediaType = details?.mediaType;
    return (!mediaType || mediaType === "audio") && isTrustedRenderer(webContents);
  });
}

function isTrustedRenderer(webContents) {
  return Boolean(
    webContents &&
      (webContents.id === mainWindow?.webContents.id || webContents.id === dictationWindow?.webContents.id)
  );
}

function createTray() {
  const icon = nativeImage.createFromPath(TRAY_ICON_PATH);
  if (process.platform === "win32" && !icon.isEmpty()) {
    icon.setTemplateImage(false);
  }
  tray = new Tray(icon);
  tray.setToolTip("Laryn");
  updateTrayMenu();
}

function updateTrayMenu() {
  if (!tray) {
    return;
  }

  const updateReady = isUpdateReadyToInstall();
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Show Laryn", click: () => showMainWindow("tray") },
      { label: "Start recording", click: startRecording },
      { label: "Stop recording", click: stopRecording },
      ...(updateReady
        ? [
            { type: "separator" },
            {
              label: "Install update and restart",
              click: () => installUpdateSafely("tray-install")
            }
          ]
        : []),
      { type: "separator" },
      {
        label: updateReady ? "Quit and install update" : "Quit",
        click: () => {
          if (updateReady) {
            installUpdateSafely("tray-quit");
            return;
          }

          shouldQuit = true;
          app.quit();
        }
      }
    ])
  );
}

function showMainWindow(reason) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
  sendMainWindowSnapshot(mainWindow);
  logInfo("window:show", { reason });
}

function registerNativeHotkey() {
  try {
    activeHotkeyBinding = parseHotkey(desktopSettings.hotkey) || parseHotkey(config.hotkey) || parseHotkey("Control+Super");
    activeHotkey = activeHotkeyBinding.hotkey;
    logInfo("hotkey:native-register:start");
    uIOhook.on("keydown", (event) => {
      updateHotkeyState(event, true);
      status.hotkeyStatus.lastEventAt = new Date().toISOString();
      if (isActiveHotkeyPressed() && !hotkeyState.recordingRequested && Date.now() - hotkeyState.lastStopAt > 250) {
        logInfo("hotkey:hold-start", {
          keycode: event.keycode,
          ctrlDown: hotkeyState.ctrlDown,
          altDown: hotkeyState.altDown,
          shiftDown: hotkeyState.shiftDown,
          winDown: hotkeyState.winDown
        });
        startRecording();
      }
    });
    uIOhook.on("keyup", (event) => {
      updateHotkeyState(event, false);
      status.hotkeyStatus.lastEventAt = new Date().toISOString();
      if (hotkeyState.recordingRequested && !isActiveHotkeyPressed()) {
        logInfo("hotkey:hold-release", {
          keycode: event.keycode,
          ctrlDown: hotkeyState.ctrlDown,
          altDown: hotkeyState.altDown,
          shiftDown: hotkeyState.shiftDown,
          winDown: hotkeyState.winDown
        });
        stopRecording();
      }
    });
    uIOhook.start();
    nativeHookReady = true;
    patchStatus({
      hotkey: activeHotkey,
      hotkeyStatus: {
        activeHotkey,
        mode: "native-hold"
      },
      state: "idle",
      message: `Hold ${displayHotkey(activeHotkey)} to dictate`
    });
    logInfo("hotkey:native-register:ok", { activeHotkey });
  } catch (error) {
    logError("hotkey:native-register:failed", error);
    registerHotkeyFallback(error);
  }
}

function registerHotkeyFallback(error) {
  activeHotkey = "unregistered";
  patchStatus({
    hotkey: activeHotkey,
    hotkeyStatus: {
      activeHotkey,
      error: error instanceof Error ? error.message : String(error),
      mode: "error"
    },
    state: "error",
    message: `Hold-to-dictate needs the native key hook. Could not start it${error instanceof Error ? `: ${error.message}` : ""}`
  });
}

function registerIpc() {
  ipcMain.handle("renderer:ready", (event) => {
    if (event.sender.id === dictationWindow?.webContents.id) {
      dictationRendererReady = true;
      resolveDictationRendererWaiters();
    }
    return status;
  });
  ipcMain.handle("settings:set-hotkey", (_event, hotkey) => setHotkey(hotkey));
  ipcMain.handle("updates:check", () => checkForUpdates("manual"));
  ipcMain.handle("updates:install", () => installUpdate("renderer"));
  ipcMain.handle("worker:check", refreshWorkerAuth);
  ipcMain.handle("auth:start-device-login", startDeviceLogin);
  ipcMain.handle("auth:poll-device-login", (_event, deviceCode, deviceName) => pollDeviceLogin(deviceCode, deviceName));
  ipcMain.handle("auth:logout", logoutDevice);
  ipcMain.handle("auth:get-account-status", getAccountStatus);
  ipcMain.handle("auth:open-account", () => shell.openExternal(`${config.workerUrl}/app`));
  ipcMain.on("window:minimize", () => mainWindow?.minimize());
  ipcMain.on("window:close", () => mainWindow?.close());
  ipcMain.on("recording:started", (_event, metadata) => {
    hotkeyState.recordingActive = true;
    hotkeyState.recordingRequested = true;
    enterDictationWindowMode();
    patchStatus({ isRecording: true, state: "recording", message: "Listening" });
    logInfo("recording:started", sanitizeRecordingMetadata(metadata));
  });
  ipcMain.on("recording:stopped", () => {
    hotkeyState.recordingActive = false;
    hotkeyState.recordingRequested = false;
    hotkeyState.lastStopAt = Date.now();
    patchStatus({ isRecording: false, state: "transcribing", message: "Transcribing" });
    logInfo("recording:stopped");
  });
  ipcMain.on("recording:cancelled", (_event, message) => {
    hotkeyState.recordingActive = false;
    hotkeyState.recordingRequested = false;
    hotkeyState.lastStopAt = Date.now();
    exitDictationWindowMode();
    patchStatus({
      isRecording: false,
      state: "idle",
      message: typeof message === "string" && message ? message : "Ready"
    });
    logWarn("recording:cancelled", { message: status.message });
  });
  ipcMain.on("recording:failed", (_event, message) => {
    hotkeyState.recordingActive = false;
    hotkeyState.recordingRequested = false;
    hotkeyState.lastStopAt = Date.now();
    exitDictationWindowMode();
    patchStatus({
      isRecording: false,
      state: "error",
      message: typeof message === "string" && message ? message : "Could not start recording"
    });
    logWarn("recording:failed", { message: status.message });
  });
  ipcMain.handle("history:list", () => {
    if (!historyCache) loadHistory();
    return historyCache || [];
  });
  ipcMain.handle("history:delete", (_event, id) => {
    deleteHistoryEntry(id);
    return historyCache || [];
  });
  ipcMain.handle("history:clear", () => {
    clearHistory();
    return [];
  });
  ipcMain.handle("dictionary:list", () => {
    if (!dictionaryCache) loadDictionary();
    return dictionaryCache || [];
  });
  ipcMain.handle("dictionary:save", (_event, entry) => saveDictionaryEntry(entry));
  ipcMain.handle("dictionary:delete", (_event, id) => {
    deleteDictionaryEntry(id);
    return dictionaryCache || [];
  });
  ipcMain.handle("dictionary:toggle", (_event, id, enabled) => {
    toggleDictionaryEntry(id, enabled);
    return dictionaryCache || [];
  });
  ipcMain.on("history:copy", (_event, text) => {
    if (typeof text === "string") {
      clipboard.writeText(text);
      logInfo("history:copy", { textLength: text.length });
    }
  });
  ipcMain.handle("transcription:submit", async (_event, audio, mimeType, durationMs, requestedCleanupTier, dictionary) => {
    cleanupTier = normalizeCleanupTier(requestedCleanupTier);
    const requestDictionary = cleanupTier === "off" ? [] : dictionaryEntriesForRequest(dictionary);
    logInfo("transcription:submit:start", {
      audioBytes: audio?.byteLength ?? audio?.length ?? null,
      mimeType,
      durationMs,
      requestedCleanupTier,
      cleanupTier,
      dictionaryEntryCount: requestDictionary.length
    });

    let result;
    try {
      result = await transcribe(audio, mimeType, durationMs, cleanupTier, requestDictionary);
    } catch (error) {
      logError("transcription:submit:failed", error);
      exitDictationWindowMode();
      throw error;
    }

    logInfo("transcription:submit:result", summarizeTranscriptionResult(result));
    if (result.text) {
      appendHistoryEntry(result, durationMs);
      patchStatus({ state: "pasting", message: "Pasting transcript", lastTranscript: result });
      try {
        hideDictationWindowForPaste();
        await pasteText(result.text);
        logInfo("paste:ok", {
          textLength: result.text.length,
          wordCount: result.wordCount
        });
      } catch (error) {
        logError("paste:failed", error);
        patchStatus({ state: "error", message: `Paste failed: ${formatErrorMessage(error)}`, lastTranscript: result });
        exitDictationWindowMode();
        throw error;
      }
      exitDictationWindowMode();
      patchStatus({ state: "idle", message: "Ready", lastTranscript: result });
      scheduleUsageCreditRefresh("transcription-complete");
    } else {
      logWarn("transcription:submit:empty-text", summarizeTranscriptionResult(result));
      exitDictationWindowMode();
      patchStatus({ state: "idle", message: "No speech detected" });
      scheduleUsageCreditRefresh("transcription-empty");
    }
    return result;
  });
}

function configureWorkerAuthPolling() {
  if (workerAuthPollTimer) {
    return;
  }

  workerAuthPollTimer = setInterval(() => {
    void refreshWorkerAuthFromPoll("interval");
  }, WORKER_AUTH_POLL_INTERVAL_MS);
  workerAuthPollTimer.unref?.();
}

async function refreshWorkerAuthFromPoll(reason) {
  if (!desktopAuth.token || workerAuthPollInFlight) {
    return;
  }

  if (isDictationBusy()) {
    return;
  }

  workerAuthPollInFlight = true;
  try {
    logInfo("worker:auth-poll:start", { reason });
    await refreshWorkerAuth();
  } catch (error) {
    logWarn("worker:auth-poll:failed", { reason, error: formatErrorForLog(error) });
  } finally {
    workerAuthPollInFlight = false;
  }
}

function scheduleUsageCreditRefresh(reason) {
  clearUsageCreditRefreshTimers();

  for (const delayMs of POST_TRANSCRIPTION_USAGE_REFRESH_DELAYS_MS) {
    scheduleUsageCreditRefreshAttempt(reason, delayMs);
  }
}

function clearUsageCreditRefreshTimers() {
  for (const timer of usageCreditRefreshTimers) {
    clearTimeout(timer);
  }
  usageCreditRefreshTimers = [];
}

function scheduleUsageCreditRefreshAttempt(reason, delayMs) {
  const timer = setTimeout(() => {
    usageCreditRefreshTimers = usageCreditRefreshTimers.filter((candidate) => candidate !== timer);

    if (!desktopAuth.token) {
      return;
    }

    if (workerAuthPollInFlight || isDictationBusy()) {
      scheduleUsageCreditRefreshAttempt(reason, DEFERRED_USAGE_REFRESH_RETRY_MS);
      return;
    }

    void refreshWorkerAuthFromPoll(reason);
  }, delayMs);
  timer.unref?.();
  usageCreditRefreshTimers.push(timer);
}

function isDictationBusy() {
  return status.state === "recording" || status.state === "transcribing" || status.state === "pasting";
}

function configureAutoUpdates() {
  if (!app.isPackaged) {
    logInfo("updates:skip-unpackaged");
    patchStatus({
      updateStatus: "disabled",
      updateMessage: "Updates are available in installed builds"
    });
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => {
    logInfo("updates:checking");
    patchStatus({
      updateStatus: "checking",
      updateMessage: "Checking for updates"
    });
  });
  autoUpdater.on("update-available", (info) => {
    logInfo("updates:available", summarizeUpdateInfo(info));
    updateReadyToInstall = false;
    updateInstallRequested = false;
    patchStatus({
      updateStatus: "downloading",
      updateMessage: `Downloading update ${info?.version || ""}`.trim(),
      updateVersion: info?.version
    });
  });
  autoUpdater.on("update-not-available", (info) => {
    logInfo("updates:not-available", summarizeUpdateInfo(info));
    updateReadyToInstall = false;
    updateInstallRequested = false;
    patchStatus({
      updateStatus: "current",
      updateMessage: "Laryn is up to date",
      updateVersion: info?.version || app.getVersion()
    });
  });
  autoUpdater.on("download-progress", (progress) => {
    const percent = Math.round(progress.percent || 0);
    logInfo("updates:download-progress", {
      percent,
      transferred: progress.transferred,
      total: progress.total
    });
    patchStatus({
      updateStatus: "downloading",
      updateMessage: `Downloading update ${percent}%`
    });
  });
  autoUpdater.on("update-downloaded", (info) => {
    logInfo("updates:downloaded", summarizeUpdateInfo(info));
    updateReadyToInstall = true;
    updateInstallRequested = false;
    patchStatus({
      updateStatus: "ready",
      updateMessage: "Update ready. Install it from Settings or quit Laryn from the tray.",
      updateVersion: info?.version
    });
    if (Notification.isSupported()) {
      new Notification({
        title: "Laryn update ready",
        body: "Click Install update in Settings, or quit Laryn from the tray to apply it."
      }).show();
    }
  });
  autoUpdater.on("error", (error) => {
    logError("updates:error", error);
    updateInstallRequested = false;
    patchStatus({
      updateStatus: "error",
      updateMessage: `Update check failed: ${formatErrorMessage(error)}`
    });
  });

  setTimeout(() => {
    checkForUpdates("startup").catch((error) => logError("updates:check-failed", error));
  }, 15000);
}

async function checkForUpdates(source) {
  if (!app.isPackaged) {
    patchStatus({
      updateStatus: "disabled",
      updateMessage: "Updates are available in installed builds"
    });
    return status;
  }

  if (updateReadyToInstall) {
    logInfo("updates:check-skipped-ready", { source });
    return status;
  }

  if (status.updateStatus === "downloading") {
    logInfo("updates:check-skipped-downloading", { source });
    return status;
  }

  if (updateCheckPromise) {
    logInfo("updates:check-joined", { source });
    try {
      await updateCheckPromise;
    } catch {
      // The active check already logged and patched status for the failure.
    }
    return status;
  }

  logInfo("updates:check-requested", { source });
  patchStatus({
    updateStatus: "checking",
    updateMessage: "Checking for updates"
  });

  try {
    updateCheckPromise = autoUpdater.checkForUpdates();
    await updateCheckPromise;
  } catch (error) {
    logError("updates:check-failed", error, { source });
    patchStatus({
      updateStatus: "error",
      updateMessage: `Update check failed: ${formatErrorMessage(error)}`
    });
  } finally {
    updateCheckPromise = null;
  }

  return status;
}

function installUpdate(source = "manual") {
  if (!app.isPackaged) {
    patchStatus({
      updateStatus: "disabled",
      updateMessage: "Updates are available in installed builds"
    });
    return status;
  }

  if (!isUpdateReadyToInstall()) {
    throw new Error("No downloaded update is ready to install.");
  }

  if (updateInstallRequested) {
    logInfo("updates:install-request-joined", { source });
    return status;
  }

  logInfo("updates:install-requested", { source });
  updateInstallRequested = true;
  shouldQuit = true;
  patchStatus({
    updateStatus: "restarting",
    updateMessage: "Restarting to install update"
  });

  setImmediate(() => {
    try {
      logInfo("updates:quit-and-install");
      autoUpdater.quitAndInstall(INSTALL_UPDATE_SILENTLY, RUN_AFTER_SILENT_UPDATE);
    } catch (error) {
      updateInstallRequested = false;
      shouldQuit = false;
      logError("updates:install-failed", error);
      patchStatus({
        updateStatus: "ready",
        updateMessage: `Could not restart for update: ${formatErrorMessage(error)}`
      });
    }
  });

  return status;
}

function installUpdateSafely(source) {
  try {
    return installUpdate(source);
  } catch (error) {
    logError("updates:install-rejected", error, { source });
    patchStatus({
      updateStatus: isUpdateReadyToInstall() ? "ready" : "error",
      updateMessage: isUpdateReadyToInstall()
        ? `Could not start update install: ${formatErrorMessage(error)}`
        : `No downloaded update is ready to install: ${formatErrorMessage(error)}`
    });
    showMainWindow("update-install-error");
    return status;
  }
}

function isUpdateReadyToInstall() {
  return updateReadyToInstall || status.updateStatus === "ready";
}

function loadPackageInfo(baseDir) {
  const candidates = [
    path.join(baseDir, "package.json"),
    path.join(baseDir, "..", "package.json")
  ];

  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) {
        continue;
      }

      const parsed = JSON.parse(fs.readFileSync(candidate, "utf8"));
      return {
        releaseName: typeof parsed.releaseName === "string" && parsed.releaseName ? parsed.releaseName : "local-dev"
      };
    } catch {
      // Continue to the next candidate. This only affects debug metadata.
    }
  }

  return { releaseName: "local-dev" };
}

function summarizeUpdateInfo(info) {
  return {
    version: info?.version,
    releaseDate: info?.releaseDate,
    files: Array.isArray(info?.files) ? info.files.map((file) => file.url).filter(Boolean) : undefined
  };
}

function setHotkey(hotkey) {
  const binding = parseHotkey(hotkey);
  if (!binding) {
    throw new Error("Use a supported hotkey such as Ctrl+Win, Ctrl+Alt+Space, or Ctrl+Shift+H.");
  }

  if (hotkeyState.recordingRequested) {
    throw new Error("Release the current hotkey before changing it.");
  }

  activeHotkeyBinding = binding;
  activeHotkey = binding.hotkey;
  desktopSettings.hotkey = binding.hotkey;
  resetHotkeyState();
  saveDesktopSettings();
  patchStatus({
    hotkey: activeHotkey,
    hotkeyStatus: {
      ...status.hotkeyStatus,
      activeHotkey,
      mode: nativeHookReady ? "native-hold" : status.hotkeyStatus.mode
    },
    message: `Hold ${displayHotkey(activeHotkey)} to dictate`
  });
  logInfo("settings:hotkey-updated", { activeHotkey });
  return status;
}

async function startDeviceLogin() {
  const deviceName = `${app.getName()} on ${process.env.COMPUTERNAME || "Windows"}`;
  const response = await fetch(`${config.workerUrl}/api/device/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceName })
  });
  const payload = await readJsonResponse(response);
  if (!response.ok) {
    throw new Error(formatWorkerErrorMessage(payload, response.status));
  }

  desktopAuth = { token: "", account: null, billing: null };
  clearUsageCreditRefreshTimers();
  authGeneration += 1;
  saveDesktopAuth();
  patchStatus({
    account: null,
    billing: null,
    authStatus: "pending",
    workerStatus: "online",
    state: "idle",
    message: `Approve device code ${payload.userCode} in your browser`,
    deviceLogin: {
      deviceCode: payload.deviceCode,
      userCode: payload.userCode,
      verificationUri: payload.verificationUri,
      expiresAt: new Date(Date.now() + Number(payload.expiresIn || 600) * 1000).toISOString()
    }
  });

  await shell.openExternal(payload.verificationUri);

  return payload;
}

async function pollDeviceLogin(deviceCode, deviceName) {
  if (!deviceCode) {
    throw new Error("Missing device code");
  }

  const response = await fetch(`${config.workerUrl}/api/device/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      deviceCode,
      deviceName: deviceName || `${app.getName()} on ${process.env.COMPUTERNAME || "Windows"}`
    })
  });
  const payload = await readJsonResponse(response);
  if (!response.ok) {
    throw new Error(formatWorkerErrorMessage(payload, response.status));
  }

  if (payload.status === "pending") {
    return payload;
  }

  if (payload.status === "approved" && typeof payload.token === "string") {
    authGeneration += 1;
    desktopAuth = {
      token: payload.token,
      account: payload.account || null,
      billing: payload.billing || null
    };
    saveDesktopAuth();
    patchStatus({
      account: desktopAuth.account,
      billing: desktopAuth.billing,
      deviceLogin: undefined,
      authStatus: payload.billing?.proActive ? "ok" : "subscription-required",
      workerStatus: "online",
      state: payload.billing?.proActive ? "idle" : "error",
      message: payload.billing?.proActive ? "Signed in and ready" : "Laryn Pro subscription required"
    });
    await refreshWorkerAuth();
  }

  return payload;
}

async function logoutDevice() {
  desktopAuth = { token: "", account: null, billing: null };
  clearUsageCreditRefreshTimers();
  authGeneration += 1;
  saveDesktopAuth();
  patchStatus({
    account: null,
    billing: null,
    deviceLogin: undefined,
    authStatus: "signed-out",
    workerStatus: "unknown",
    state: "idle",
    message: "Signed out"
  });
  return { ok: true };
}

async function getAccountStatus() {
  await refreshWorkerAuth();
  return {
    account: desktopAuth.account,
    billing: desktopAuth.billing,
    authStatus: status.authStatus,
    workerStatus: status.workerStatus,
    message: status.message
  };
}

async function startRecording() {
  ensureDictationWindow();

  if (!dictationWindow || hotkeyState.recordingRequested) {
    logWarn("recording:start:ignored", {
      hasWindow: Boolean(dictationWindow),
      recordingRequested: hotkeyState.recordingRequested
    });
    return;
  }

  if (status.state === "transcribing" || status.state === "pasting") {
    logWarn("recording:start:busy", {
      state: status.state,
      message: status.message
    });
    return;
  }

  if (!canRecord()) {
    logWarn("recording:start:blocked", {
      authStatus: status.authStatus,
      workerStatus: status.workerStatus,
      message: workerAuthMessage()
    });
    patchStatus({
      state: "error",
      message: workerAuthMessage()
    });
    return;
  }

  hotkeyState.recordingRequested = true;
  enterDictationWindowMode();
  logInfo("recording:start:send-renderer");
  await sendToDictationWindow("recording:start");
}

async function stopRecording() {
  if (!dictationWindow || dictationWindow.isDestroyed() || !hotkeyState.recordingRequested) {
    logWarn("recording:stop:ignored", {
      hasWindow: Boolean(dictationWindow),
      recordingRequested: hotkeyState.recordingRequested
    });
    return;
  }

  hotkeyState.recordingRequested = false;
  hotkeyState.lastStopAt = Date.now();
  logInfo("recording:stop:send-renderer");
  await sendToDictationWindow("recording:stop");
}

async function transcribe(audio, mimeType, durationMs, selectedCleanupTier, dictionaryEntries = []) {
  if (!canRecord()) {
    logInfo("transcribe:refresh-auth-before-submit", {
      authStatus: status.authStatus,
      workerStatus: status.workerStatus
    });
    await refreshWorkerAuth();
  }

  if (!canRecord()) {
    const message = workerAuthMessage();
    logWarn("transcribe:blocked-after-auth-refresh", {
      authStatus: status.authStatus,
      workerStatus: status.workerStatus,
      message
    });
    patchStatus({ state: "error", message });
    throw new Error(message);
  }

  const form = new FormData();
  form.append("audio", new Blob([audio], { type: mimeType }), `laryn-${Date.now()}.webm`);
  form.append("durationMs", String(durationMs));
  form.append("cleanupTier", selectedCleanupTier);
  if (selectedCleanupTier !== "off" && dictionaryEntries.length > 0) {
    form.append("dictionary", JSON.stringify({ version: DICTIONARY_VERSION, entries: dictionaryEntries }));
  }

  const url = `${config.workerUrl}/v1/transcriptions`;
  const startedAt = Date.now();
  logInfo("worker:transcription-request:start", {
    url,
    audioBytes: audio?.byteLength ?? audio?.length ?? null,
    mimeType,
    durationMs,
    cleanupTier: selectedCleanupTier,
    dictionaryEntryCount: selectedCleanupTier === "off" ? 0 : dictionaryEntries.length
  });

  const response = await fetch(url, {
    method: "POST",
    headers: authHeaders(),
    body: form
  });

  const payload = await readJsonResponse(response);
  logInfo("worker:transcription-request:response", {
    status: response.status,
    ok: response.ok,
    contentType: response.headers.get("content-type"),
    elapsedMs: Date.now() - startedAt,
    payload: summarizePayload(payload)
  });

  const payloadIsObject = payload && typeof payload === "object";
  if (!response.ok || (payloadIsObject && "error" in payload)) {
    const message = payloadIsObject && "error" in payload
      ? formatWorkerErrorMessage(payload, response.status)
      : `Worker request failed with HTTP ${response.status}`;
    if (response.status === 402 || payload.error === "Subscription required") {
      desktopAuth.billing = payload.billing || desktopAuth.billing;
      saveDesktopAuth();
      patchStatus({
        authStatus: "subscription-required",
        workerStatus: "online",
        billing: desktopAuth.billing,
        state: "error",
        message
      });
    }
    logWarn("worker:transcription-request:error", {
      status: response.status,
      message,
      payload: summarizePayload(payload)
    });
    patchStatus({ state: "error", message });
    throw new Error(message);
  }

  return payload;
}

function formatWorkerErrorMessage(payload, statusCode) {
  const error = typeof payload.error === "string" ? payload.error : `HTTP ${statusCode}`;
  const detail = typeof payload.detail === "string" ? payload.detail : "";

  if (detail.startsWith("<!DOCTYPE html>") || detail.includes("<html")) {
    return `Worker returned an HTML error page (HTTP ${statusCode}). Check Worker logs.`;
  }

  return detail || error;
}

async function pasteText(text) {
  logInfo("paste:start", {
    textLength: text.length
  });
  clipboard.writeText(text);
  await new Promise((resolve) => setTimeout(resolve, 220));
  const pasteScript = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class Keyboard {
  [DllImport("user32.dll", SetLastError=true)]
  public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
"@
[Keyboard]::keybd_event(0x11,0,0,[UIntPtr]::Zero)
[Keyboard]::keybd_event(0x56,0,0,[UIntPtr]::Zero)
Start-Sleep -Milliseconds 30
[Keyboard]::keybd_event(0x56,0,2,[UIntPtr]::Zero)
[Keyboard]::keybd_event(0x11,0,2,[UIntPtr]::Zero)
`;
  const { stdout, stderr } = await execFileAsync("powershell.exe", [
    "-NoProfile",
    "-STA",
    "-Command",
    pasteScript
  ]);
  logInfo("paste:powershell-complete", {
    stdout: stdout.trim().slice(0, 200),
    stderr: stderr.trim().slice(0, 200)
  });
}

function enterDictationWindowMode() {
  if (!dictationWindow || dictationWindow.isDestroyed()) {
    return;
  }

  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const bounds = getCenteredOverlayBounds(display, DICTATION_WINDOW_WIDTH, DICTATION_WINDOW_HEIGHT);
  revealDictationWindow(bounds);
}

function exitDictationWindowMode() {
  if (!dictationWindow || dictationWindow.isDestroyed()) {
    return;
  }

  if (dictationWindow.isVisible()) {
    dictationWindow.hide();
  }
  dictationWindow.setAlwaysOnTop(false);
}

function hideDictationWindowForPaste() {
  if (!dictationWindow || dictationWindow.isDestroyed()) {
    return;
  }

  if (dictationWindow.isVisible()) {
    dictationWindow.hide();
  }
}

function revealDictationWindow(bounds) {
  if (!dictationWindow || dictationWindow.isDestroyed()) {
    return;
  }

  const window = dictationWindow;

  const showOnce = () => {
    if (window.isDestroyed()) return;
    window.setBounds(bounds);
    window.setAlwaysOnTop(true, "screen-saver");
    window.setSkipTaskbar(true);
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    window.showInactive();
  };

  if (dictationWindowReady) {
    showOnce();
    return;
  }

  const revealSubscribers = [(fire) => window.once("ready-to-show", fire)];
  if (process.platform === "linux") {
    revealSubscribers.push((fire) => window.webContents.once("did-finish-load", fire));
  }
  bindFirstRevealTrigger(revealSubscribers, () => {
    dictationWindowReady = true;
    showOnce();
  });
}

async function sendToDictationWindow(channel) {
  if (!dictationWindow || dictationWindow.isDestroyed()) {
    return;
  }

  if (dictationWindow.webContents.isLoading()) {
    await new Promise((resolve) => {
      dictationWindow.webContents.once("did-finish-load", resolve);
    });
  }

  await waitForDictationRendererReady();

  if (!dictationWindow.isDestroyed()) {
    dictationWindow.webContents.send(channel);
  }
}

function waitForDictationRendererReady(timeoutMs = 5000) {
  if (dictationRendererReady || !dictationWindow || dictationWindow.isDestroyed()) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const waiter = () => {
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(() => {
      logWarn("dictation:renderer-ready-timeout", { timeoutMs });
      resolveDictationRendererWaiter(waiter);
      resolve();
    }, timeoutMs);
    timeout.unref?.();

    dictationRendererReadyWaiters.push(waiter);
  });
}

function resolveDictationRendererWaiter(targetWaiter) {
  dictationRendererReadyWaiters = dictationRendererReadyWaiters.filter((waiter) => waiter !== targetWaiter);
}

function resolveDictationRendererWaiters() {
  const waiters = dictationRendererReadyWaiters;
  dictationRendererReadyWaiters = [];
  for (const resolve of waiters) {
    resolve();
  }
}

function getCenteredOverlayBounds(display, width, height) {
  const workArea = display?.workArea || screen.getPrimaryDisplay().workArea;
  return {
    width,
    height,
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + workArea.height - height - DICTATION_BOTTOM_OFFSET)
  };
}

function patchStatus(next) {
  Object.assign(status, next);
  if (Object.prototype.hasOwnProperty.call(next, "updateStatus")) {
    updateTrayMenu();
  }
  queueStatusBroadcast();

  if (next.state === "error" && Notification.isSupported()) {
    new Notification({ title: "Laryn", body: status.message }).show();
  }
}

function queueStatusBroadcast() {
  if (statusBroadcastQueued) {
    return;
  }

  statusBroadcastQueued = true;
  setImmediate(() => {
    statusBroadcastQueued = false;
    broadcastStatus();
  });
}

function broadcastStatus() {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
    mainWindow.webContents.send("desktop:status", status);
  }
  if (dictationWindow && !dictationWindow.isDestroyed()) {
    dictationWindow.webContents.send("desktop:status", status);
  }
}

function sendMainWindowSnapshot(window) {
  if (!window || window.isDestroyed()) {
    return;
  }

  window.webContents.send("desktop:status", status);
  if (historyCache) {
    window.webContents.send("desktop:history-changed", historyCache);
  }
}

async function refreshWorkerAuth() {
  const generation = authGeneration;
  const token = desktopAuth.token;

  if (!token) {
    logWarn("worker:auth:signed-out");
    if (status.authStatus === "pending" && status.deviceLogin) {
      patchStatus({
        workerStatus: status.workerStatus === "unknown" ? "online" : status.workerStatus,
        message: `Approve device code ${status.deviceLogin.userCode} in your browser`
      });
      return status;
    }

    patchStatus({
      authStatus: "signed-out",
      workerStatus: "unknown",
      message: "Sign in to connect Laryn"
    });
    return status;
  }

  try {
    logInfo("worker:health:start", { url: `${config.workerUrl}/health` });
    const health = await fetch(`${config.workerUrl}/health`);
    logInfo("worker:health:response", { status: health.status, ok: health.ok });
    if (generation !== authGeneration || token !== desktopAuth.token) {
      logInfo("worker:health:stale", { generation, currentGeneration: authGeneration });
      return status;
    }

    if (!health.ok) {
      patchStatus({
        authStatus: "unknown",
        workerStatus: "offline",
        message: `Worker health failed at ${config.workerUrl}`
      });
      return status;
    }
  } catch {
    if (generation !== authGeneration || token !== desktopAuth.token) {
      logInfo("worker:health:stale-after-error", { generation, currentGeneration: authGeneration });
      return status;
    }

    logWarn("worker:health:offline", { workerUrl: config.workerUrl });
    patchStatus({
      authStatus: "unknown",
      workerStatus: "offline",
      message: `Worker offline at ${config.workerUrl}`
    });
    return status;
  }

  try {
    logInfo("worker:auth-check:start", { url: `${config.workerUrl}/health/auth` });
    const response = await fetch(`${config.workerUrl}/health/auth`, {
      headers: authHeaders(token)
    });
    logInfo("worker:auth-check:response", { status: response.status, ok: response.ok });
    if (generation !== authGeneration || token !== desktopAuth.token) {
      logInfo("worker:auth-check:stale", { generation, currentGeneration: authGeneration });
      return status;
    }

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

    const authPayload = await readJsonResponse(response);
    if (generation !== authGeneration || token !== desktopAuth.token) {
      logInfo("worker:auth-check:stale-after-body", { generation, currentGeneration: authGeneration });
      return status;
    }

    desktopAuth.billing = authPayload.billing || {
      ...(desktopAuth.billing || {}),
      proActive: Boolean(authPayload.proActive),
      subscriptionStatus: authPayload.proActive ? "active" : desktopAuth.billing?.subscriptionStatus || "unknown"
    };
    saveDesktopAuth();

    if (!desktopAuth.billing?.proActive) {
      patchStatus({
        authStatus: "subscription-required",
        workerStatus: "online",
        billing: desktopAuth.billing,
        account: desktopAuth.account,
        state: "error",
        message: "Laryn Pro subscription required"
      });
      return status;
    }

    patchStatus({
      authStatus: "ok",
      workerStatus: "online",
      billing: desktopAuth.billing,
      account: desktopAuth.account,
      state: "idle",
      message: `Worker online at ${config.workerUrl}`
    });
  } catch {
    if (generation !== authGeneration || token !== desktopAuth.token) {
      logInfo("worker:auth-check:stale-after-error", { generation, currentGeneration: authGeneration });
      return status;
    }

    logWarn("worker:auth-check:failed", { workerUrl: config.workerUrl });
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

function authHeaders(token = desktopAuth.token) {
  return token ? { authorization: `Bearer ${token}` } : undefined;
}

function canRecord() {
  return status.workerStatus === "online" && status.authStatus === "ok";
}

function workerAuthMessage() {
  if (!desktopAuth.token) {
    return "Sign in to connect Laryn";
  }

  if (status.authStatus === "subscription-required") {
    return "Laryn Pro subscription required";
  }

  if (status.authStatus === "unauthorized" || status.workerStatus === "unauthorized") {
    return `Worker auth failed for ${config.workerUrl}. Sign in again from Settings.`;
  }

  return `Worker unavailable at ${config.workerUrl}. Check the Worker dev server and port.`;
}

function displayHotkey(hotkey) {
  return hotkey.replaceAll("Control", "Ctrl").replaceAll("Super", "Win").replaceAll("+", " + ");
}

function getSafeExternalUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function isActiveHotkeyPressed() {
  const binding = activeHotkeyBinding;
  if (!binding) return false;

  return (
    (!binding.modifiers.ctrl || hotkeyState.ctrlDown) &&
    (!binding.modifiers.alt || hotkeyState.altDown) &&
    (!binding.modifiers.shift || hotkeyState.shiftDown) &&
    (!binding.modifiers.win || hotkeyState.winDown) &&
    (!binding.keyCode || hotkeyState.pressedKeyCodes.has(binding.keyCode))
  );
}

function resolveAssetPath(fileName) {
  const localPath = path.join(__dirname, "assets", fileName);
  if (fs.existsSync(localPath)) {
    return localPath;
  }

  return path.join(__dirname, "..", "assets", fileName);
}

function updateHotkeyState(event, isPressed) {
  const isCtrlCode = event.keycode === UiohookKey.Ctrl || event.keycode === UiohookKey.CtrlRight;
  const isAltCode = event.keycode === UiohookKey.Alt || event.keycode === UiohookKey.AltRight;
  const isShiftCode = event.keycode === UiohookKey.Shift || event.keycode === UiohookKey.ShiftRight;
  const isMetaCode = event.keycode === UiohookKey.Meta || event.keycode === UiohookKey.MetaRight;

  if (isPressed) {
    hotkeyState.pressedKeyCodes.add(event.keycode);
  } else {
    hotkeyState.pressedKeyCodes.delete(event.keycode);
  }

  if (isCtrlCode) {
    hotkeyState.ctrlDown = isPressed || event.type === EventType.EVENT_KEY_PRESSED;
  } else {
    hotkeyState.ctrlDown = isPressed ? event.ctrlKey || hotkeyState.ctrlDown : event.ctrlKey;
  }

  if (isAltCode) {
    hotkeyState.altDown = isPressed || event.type === EventType.EVENT_KEY_PRESSED;
  } else {
    hotkeyState.altDown = isPressed ? event.altKey || hotkeyState.altDown : event.altKey;
  }

  if (isShiftCode) {
    hotkeyState.shiftDown = isPressed || event.type === EventType.EVENT_KEY_PRESSED;
  } else {
    hotkeyState.shiftDown = isPressed ? event.shiftKey || hotkeyState.shiftDown : event.shiftKey;
  }

  if (isMetaCode) {
    hotkeyState.winDown = isPressed || event.type === EventType.EVENT_KEY_PRESSED;
  } else {
    hotkeyState.winDown = isPressed ? event.metaKey || hotkeyState.winDown : event.metaKey;
  }

  hotkeyState.lastEventAt = Date.now();
}

function resetHotkeyState() {
  hotkeyState.ctrlDown = false;
  hotkeyState.altDown = false;
  hotkeyState.shiftDown = false;
  hotkeyState.winDown = false;
  hotkeyState.pressedKeyCodes.clear();
}

const HOTKEY_KEY_CODES = {
  ...Object.fromEntries("ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((key) => [key, UiohookKey[key]])),
  ...Object.fromEntries("0123456789".split("").map((key) => [key, UiohookKey[key]])),
  Space: UiohookKey.Space,
  Enter: UiohookKey.Enter,
  Escape: UiohookKey.Escape,
  Tab: UiohookKey.Tab,
  Backspace: UiohookKey.Backspace,
  Delete: UiohookKey.Delete,
  Insert: UiohookKey.Insert,
  Home: UiohookKey.Home,
  End: UiohookKey.End,
  PageUp: UiohookKey.PageUp,
  PageDown: UiohookKey.PageDown,
  ArrowUp: UiohookKey.ArrowUp,
  ArrowDown: UiohookKey.ArrowDown,
  ArrowLeft: UiohookKey.ArrowLeft,
  ArrowRight: UiohookKey.ArrowRight,
  Minus: UiohookKey.Minus,
  Equal: UiohookKey.Equal,
  Comma: UiohookKey.Comma,
  Period: UiohookKey.Period,
  Slash: UiohookKey.Slash,
  Backslash: UiohookKey.Backslash,
  Semicolon: UiohookKey.Semicolon,
  Quote: UiohookKey.Quote,
  Backquote: UiohookKey.Backquote,
  BracketLeft: UiohookKey.BracketLeft,
  BracketRight: UiohookKey.BracketRight,
  F1: UiohookKey.F1,
  F2: UiohookKey.F2,
  F3: UiohookKey.F3,
  F4: UiohookKey.F4,
  F5: UiohookKey.F5,
  F6: UiohookKey.F6,
  F7: UiohookKey.F7,
  F8: UiohookKey.F8,
  F9: UiohookKey.F9,
  F10: UiohookKey.F10,
  F11: UiohookKey.F11,
  F12: UiohookKey.F12
};

const HOTKEY_ALIASES = {
  CTRL: "Control",
  CONTROL: "Control",
  CMD: "Super",
  COMMAND: "Super",
  META: "Super",
  SUPER: "Super",
  WIN: "Super",
  WINDOWS: "Super",
  OPTION: "Alt",
  ALT: "Alt",
  SHIFT: "Shift",
  ESC: "Escape",
  ESCAPE: "Escape",
  SPACE: "Space",
  SPACEBAR: "Space",
  RETURN: "Enter",
  ENTER: "Enter",
  DEL: "Delete",
  DELETE: "Delete",
  INS: "Insert",
  INSERT: "Insert",
  PGUP: "PageUp",
  PAGEUP: "PageUp",
  PGDN: "PageDown",
  PAGEDOWN: "PageDown",
  UP: "ArrowUp",
  DOWN: "ArrowDown",
  LEFT: "ArrowLeft",
  RIGHT: "ArrowRight",
  "-": "Minus",
  "=": "Equal",
  ",": "Comma",
  ".": "Period",
  "/": "Slash",
  "\\": "Backslash",
  ";": "Semicolon",
  "'": "Quote",
  "`": "Backquote",
  "[": "BracketLeft",
  "]": "BracketRight"
};

function parseHotkey(value) {
  if (typeof value !== "string") return null;

  const parts = value
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean)
    .map(normalizeHotkeyPart);
  if (parts.length === 0) return null;

  const modifiers = { ctrl: false, alt: false, shift: false, win: false };
  const modifierParts = [];
  let key = "";
  for (const part of parts) {
    if (!part) return null;
    if (part === "Control") {
      modifiers.ctrl = true;
      if (!modifierParts.includes(part)) modifierParts.push(part);
    } else if (part === "Alt") {
      modifiers.alt = true;
      if (!modifierParts.includes(part)) modifierParts.push(part);
    } else if (part === "Shift") {
      modifiers.shift = true;
      if (!modifierParts.includes(part)) modifierParts.push(part);
    } else if (part === "Super") {
      modifiers.win = true;
      if (!modifierParts.includes(part)) modifierParts.push(part);
    } else if (HOTKEY_KEY_CODES[part] && !key) {
      key = part;
    } else {
      return null;
    }
  }

  const modifierCount = modifierParts.length;
  if (modifierCount === 0 || (!key && modifierCount < 2)) return null;

  const orderedModifiers = ["Control", "Alt", "Shift", "Super"].filter((part) => modifierParts.includes(part));
  return {
    hotkey: [...orderedModifiers, key].filter(Boolean).join("+"),
    key,
    keyCode: key ? HOTKEY_KEY_CODES[key] : null,
    modifiers
  };
}

function normalizeHotkeyPart(part) {
  const upper = part.replace(/\s+/g, "").toUpperCase();
  if (/^F([1-9]|1[0-2])$/.test(upper)) return upper;
  if (/^[A-Z0-9]$/.test(upper)) return upper;
  return HOTKEY_ALIASES[upper] || "";
}

function configureLogging() {
  const logDir = path.join(app.getPath("userData"), "logs");
  fs.mkdirSync(logDir, { recursive: true });
  logFilePath = path.join(logDir, "laryn-desktop.log");
  logSink?.close();
  logSink = createBufferedLogSink(logFilePath);
  authFilePath = path.join(app.getPath("userData"), "desktop-auth.json");
  historyFilePath = path.join(app.getPath("userData"), "history.json");
  settingsFilePath = path.join(app.getPath("userData"), "settings.json");
  dictionaryFilePath = path.join(app.getPath("userData"), "dictionary.json");
  logInfo("logging:ready", { logFilePath });
}

function loadDesktopSettings() {
  if (!settingsFilePath) return;

  try {
    if (fs.existsSync(settingsFilePath)) {
      const parsed = JSON.parse(fs.readFileSync(settingsFilePath, "utf8"));
      if (parsed && typeof parsed.hotkey === "string" && parseHotkey(parsed.hotkey)) {
        desktopSettings.hotkey = parseHotkey(parsed.hotkey).hotkey;
      }
    }
  } catch (error) {
    logWarn("settings:load-failed", { error: formatErrorForLog(error) });
  }
}

function saveDesktopSettings() {
  if (!settingsFilePath) return;

  try {
    fs.writeFileSync(settingsFilePath, JSON.stringify(desktopSettings, null, 2), "utf8");
  } catch (error) {
    logWarn("settings:save-failed", { error: formatErrorForLog(error) });
  }
}

function loadHistory() {
  if (!historyFilePath) {
    historyCache = [];
    return;
  }

  try {
    if (!fs.existsSync(historyFilePath)) {
      historyCache = [];
      return;
    }

    const raw = fs.readFileSync(historyFilePath, "utf8");
    const parsed = JSON.parse(raw);
    historyCache = Array.isArray(parsed) ? parsed.filter(isValidHistoryEntry) : [];
  } catch (error) {
    logWarn("history:load-failed", { error: formatErrorForLog(error) });
    historyCache = [];
  }
}

function saveHistory() {
  if (!historyFilePath || !historyCache) return;

  try {
    fs.writeFileSync(historyFilePath, JSON.stringify(historyCache), "utf8");
  } catch (error) {
    logWarn("history:save-failed", { error: formatErrorForLog(error) });
  }
}

function loadDictionary() {
  if (!dictionaryFilePath) {
    dictionaryCache = [];
    return;
  }

  try {
    if (!fs.existsSync(dictionaryFilePath)) {
      dictionaryCache = [];
      return;
    }

    const raw = fs.readFileSync(dictionaryFilePath, "utf8");
    const parsed = JSON.parse(raw);
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : Array.isArray(parsed) ? parsed : [];
    dictionaryCache = normalizeDictionaryEntries(entries, { maxEntries: MAX_DICTIONARY_ENTRIES, allowDisabled: true }).entries;
  } catch (error) {
    logWarn("dictionary:load-failed", { error: formatErrorForLog(error) });
    dictionaryCache = [];
  }
}

function saveDictionary() {
  if (!dictionaryFilePath || !dictionaryCache) return;

  try {
    fs.writeFileSync(dictionaryFilePath, JSON.stringify({ version: DICTIONARY_VERSION, entries: dictionaryCache }, null, 2), "utf8");
  } catch (error) {
    logWarn("dictionary:save-failed", { error: formatErrorForLog(error) });
  }
}

function saveDictionaryEntry(entry) {
  if (!dictionaryCache) loadDictionary();
  const now = new Date().toISOString();
  const existing =
    entry && typeof entry.id === "string"
      ? dictionaryCache.find((candidate) => candidate.id === entry.id)
      : null;
  const candidate = {
    id: existing?.id || generateDictionaryId(),
    kind: entry?.kind === "replacement" ? "replacement" : "vocabulary",
    phrase: entry?.phrase,
    replacement: entry?.replacement,
    enabled: typeof entry?.enabled === "boolean" ? entry.enabled : existing?.enabled !== false,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    useCount: typeof existing?.useCount === "number" ? existing.useCount : 0
  };
  const normalized = normalizeDictionaryEntry(candidate);
  if (!normalized) {
    throw new Error("Dictionary entry is invalid.");
  }

  const next = [normalized, ...dictionaryCache.filter((item) => item.id !== normalized.id)];
  const result = normalizeDictionaryEntries(next, { maxEntries: MAX_DICTIONARY_ENTRIES, allowDisabled: true });
  dictionaryCache = result.entries;
  saveDictionary();
  logInfo("dictionary:save", { id: normalized.id, kind: normalized.kind, enabled: normalized.enabled, count: dictionaryCache.length });
  return dictionaryCache;
}

function deleteDictionaryEntry(id) {
  if (!dictionaryCache) loadDictionary();
  if (typeof id !== "string") return;
  const before = dictionaryCache.length;
  dictionaryCache = dictionaryCache.filter((entry) => entry.id !== id);
  if (dictionaryCache.length !== before) {
    saveDictionary();
    logInfo("dictionary:delete", { id, remaining: dictionaryCache.length });
  }
}

function toggleDictionaryEntry(id, enabled) {
  if (!dictionaryCache) loadDictionary();
  if (typeof id !== "string") return;
  let changed = false;
  dictionaryCache = dictionaryCache.map((entry) => {
    if (entry.id !== id) return entry;
    changed = true;
    return { ...entry, enabled: Boolean(enabled), updatedAt: new Date().toISOString() };
  });
  const result = normalizeDictionaryEntries(dictionaryCache, { maxEntries: MAX_DICTIONARY_ENTRIES, allowDisabled: true });
  dictionaryCache = result.entries;
  if (changed) {
    saveDictionary();
    logInfo("dictionary:toggle", { id, enabled: Boolean(enabled) });
  }
}

function dictionaryEntriesForRequest(input) {
  const source = Array.isArray(input) ? input : dictionaryCache || [];
  const result = normalizeDictionaryEntries(source, { maxEntries: MAX_DICTIONARY_SEND_ENTRIES, allowDisabled: false });
  return result.entries;
}

function normalizeDictionaryEntries(entries, options = {}) {
  const maxEntries = options.maxEntries || MAX_DICTIONARY_SEND_ENTRIES;
  const allowDisabled = options.allowDisabled !== false;
  const normalized = [];
  const vocabularyKeys = new Set();
  const replacementKeys = new Set();
  const sorted = [...(Array.isArray(entries) ? entries : [])].sort((a, b) => {
    const aTime = Date.parse(typeof a?.updatedAt === "string" ? a.updatedAt : "");
    const bTime = Date.parse(typeof b?.updatedAt === "string" ? b.updatedAt : "");
    return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0);
  });

  for (const entry of sorted) {
    const next = normalizeDictionaryEntry(entry);
    if (!next) continue;
    if (!allowDisabled && !next.enabled) continue;

    const phraseKey = next.phrase.toLocaleLowerCase();
    if (next.kind === "vocabulary") {
      if (next.enabled && vocabularyKeys.has(phraseKey)) continue;
      if (next.enabled) vocabularyKeys.add(phraseKey);
    } else {
      if (next.enabled && replacementKeys.has(phraseKey)) continue;
      if (next.enabled) replacementKeys.add(phraseKey);
    }

    normalized.push(next);
    if (normalized.length >= maxEntries) break;
  }

  return {
    entries: normalized,
    truncated: sorted.length > normalized.length && normalized.length >= maxEntries
  };
}

function normalizeDictionaryEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const kind = entry.kind === "replacement" ? "replacement" : "vocabulary";
  const phrase = normalizeDictionaryText(entry.phrase, MAX_DICTIONARY_PHRASE_LENGTH);
  const replacement = normalizeDictionaryText(entry.replacement, MAX_DICTIONARY_REPLACEMENT_LENGTH);
  if (!phrase) return null;
  if (kind === "replacement" && (!replacement || phrase.toLocaleLowerCase() === replacement.toLocaleLowerCase())) return null;
  const now = new Date().toISOString();

  return {
    id: typeof entry.id === "string" && entry.id ? entry.id : generateDictionaryId(),
    kind,
    phrase,
    replacement: kind === "replacement" ? replacement : undefined,
    enabled: entry.enabled !== false,
    createdAt: typeof entry.createdAt === "string" && entry.createdAt ? entry.createdAt : now,
    updatedAt: typeof entry.updatedAt === "string" && entry.updatedAt ? entry.updatedAt : now,
    useCount: typeof entry.useCount === "number" && Number.isFinite(entry.useCount) ? Math.max(0, Math.floor(entry.useCount)) : 0
  };
}

function normalizeDictionaryText(value, maxLength) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength).trim();
}

function isValidHistoryEntry(entry) {
  return Boolean(
    entry &&
      typeof entry === "object" &&
      typeof entry.id === "string" &&
      typeof entry.text === "string" &&
      typeof entry.createdAt === "string"
  );
}

function appendHistoryEntry(transcript, durationFallbackMs) {
  if (!historyCache) loadHistory();
  if (!historyCache) historyCache = [];

  const text = typeof transcript?.text === "string" ? transcript.text : "";
  const wordCount =
    typeof transcript?.wordCount === "number"
      ? transcript.wordCount
      : text.split(/\s+/).filter(Boolean).length;
  const durationMs =
    typeof transcript?.durationMs === "number" && transcript.durationMs > 0
      ? transcript.durationMs
      : typeof durationFallbackMs === "number"
        ? Math.max(0, durationFallbackMs)
        : 0;

  const entry = {
    id: typeof transcript?.id === "string" && transcript.id ? transcript.id : generateLocalHistoryId(),
    createdAt: new Date().toISOString(),
    text,
    rawText: typeof transcript?.rawText === "string" ? transcript.rawText : undefined,
    cleanedText: typeof transcript?.cleanedText === "string" ? transcript.cleanedText : undefined,
    pastedVariant: transcript?.pastedVariant === "raw" ? "raw" : "cleaned",
    cleanupApplied: Boolean(transcript?.cleanupApplied),
    cleanupTier: typeof transcript?.cleanupTier === "string" ? transcript.cleanupTier : "off",
    cleanupModel: typeof transcript?.cleanupModel === "string" ? transcript.cleanupModel : undefined,
    cleanupWarning: typeof transcript?.cleanupWarning === "string" ? transcript.cleanupWarning : undefined,
    fallbackUsed: Boolean(transcript?.fallbackUsed),
    dictionaryApplied: typeof transcript?.dictionaryApplied === "boolean" ? transcript.dictionaryApplied : undefined,
    dictionaryEntryCount: typeof transcript?.dictionaryEntryCount === "number" ? transcript.dictionaryEntryCount : undefined,
    dictionaryWarning: typeof transcript?.dictionaryWarning === "string" ? transcript.dictionaryWarning : undefined,
    wordCount,
    durationMs,
    transcriptionModel:
      typeof transcript?.transcriptionModel === "string" ? transcript.transcriptionModel : undefined,
    transcriptionProvider:
      typeof transcript?.transcriptionProvider === "string" ? transcript.transcriptionProvider : undefined
  };

  historyCache.unshift(entry);
  if (historyCache.length > MAX_HISTORY_ENTRIES) {
    historyCache.length = MAX_HISTORY_ENTRIES;
  }
  saveHistory();
  broadcastHistoryChanged();
  return entry;
}

function deleteHistoryEntry(id) {
  if (!historyCache || typeof id !== "string") return;
  const before = historyCache.length;
  historyCache = historyCache.filter((entry) => entry.id !== id);
  if (historyCache.length !== before) {
    saveHistory();
    broadcastHistoryChanged();
    logInfo("history:delete", { id, remaining: historyCache.length });
  }
}

function clearHistory() {
  historyCache = [];
  saveHistory();
  broadcastHistoryChanged();
  logInfo("history:clear");
}

function broadcastHistoryChanged() {
  if (!historyCache) return;
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
    mainWindow.webContents.send("desktop:history-changed", historyCache);
  }
}

function generateLocalHistoryId() {
  return `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function generateDictionaryId() {
  return `dict-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function loadDesktopAuth() {
  if (!authFilePath || !fs.existsSync(authFilePath)) {
    return;
  }

  try {
    const payload = JSON.parse(fs.readFileSync(authFilePath, "utf8"));
    const token = decryptStoredToken(payload.token);
    desktopAuth = {
      token,
      account: payload.account || null,
      billing: payload.billing || null
    };
    if (token) {
      patchStatus({
        account: desktopAuth.account,
        billing: desktopAuth.billing,
        authStatus: "unknown",
        message: "Checking account"
      });
    }
  } catch (error) {
    logWarn("auth:load-failed", { error: formatErrorForLog(error) });
    desktopAuth = { token: "", account: null, billing: null };
  }
}

function saveDesktopAuth() {
  if (!authFilePath) {
    return;
  }

  if (!desktopAuth.token) {
    try {
      if (fs.existsSync(authFilePath)) {
        fs.unlinkSync(authFilePath);
      }
    } catch (error) {
      logWarn("auth:delete-failed", { error: formatErrorForLog(error) });
    }
    return;
  }

  const payload = {
    token: encryptStoredToken(desktopAuth.token),
    account: desktopAuth.account,
    billing: desktopAuth.billing
  };
  try {
    fs.writeFileSync(authFilePath, JSON.stringify(payload, null, 2), "utf8");
  } catch (error) {
    logWarn("auth:save-failed", { error: formatErrorForLog(error) });
  }
}

function encryptStoredToken(token) {
  const bytes = Buffer.from(token, "utf8");
  if (safeStorage.isEncryptionAvailable()) {
    return {
      encoding: "safeStorage",
      value: safeStorage.encryptString(token).toString("base64")
    };
  }

  return {
    encoding: "base64",
    value: bytes.toString("base64")
  };
}

function decryptStoredToken(payload) {
  if (!payload || typeof payload.value !== "string") {
    return "";
  }

  if (payload.encoding === "safeStorage") {
    return safeStorage.decryptString(Buffer.from(payload.value, "base64"));
  }

  if (payload.encoding === "base64") {
    return Buffer.from(payload.value, "base64").toString("utf8");
  }

  return "";
}

function logInfo(event, details) {
  writeLog("info", event, details);
}

function logWarn(event, details) {
  writeLog("warn", event, details);
}

function logError(event, error, details) {
  writeLog("error", event, {
    ...details,
    error: formatErrorForLog(error)
  });
}

function writeLog(level, event, details) {
  const entry = {
    at: new Date().toISOString(),
    level,
    event,
    ...(details === undefined ? {} : { details })
  };
  const line = JSON.stringify(entry);
  const method = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  method(`[laryn] ${line}`);

  if (!logSink) {
    return;
  }

  logSink.write(`${line}\n`);
}

function formatErrorForLog(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack?.split("\n").slice(0, 8).join("\n")
    };
  }

  return { message: String(error) };
}

function formatErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function summarizePayload(payload) {
  if (!payload || typeof payload !== "object") {
    return { type: typeof payload };
  }

  const keys = Object.keys(payload);
  return {
    keys,
    error: typeof payload.error === "string" ? payload.error : undefined,
    detail: typeof payload.detail === "string" ? payload.detail.slice(0, 240) : undefined,
    textLength: typeof payload.text === "string" ? payload.text.length : undefined,
    rawTextLength: typeof payload.rawText === "string" ? payload.rawText.length : undefined,
    cleanedTextLength: typeof payload.cleanedText === "string" ? payload.cleanedText.length : undefined,
    wordCount: typeof payload.wordCount === "number" ? payload.wordCount : undefined,
    durationMs: typeof payload.durationMs === "number" ? payload.durationMs : undefined,
    transcriptionModel: typeof payload.transcriptionModel === "string" ? payload.transcriptionModel : undefined,
    cleanupModel: typeof payload.cleanupModel === "string" ? payload.cleanupModel : undefined,
    cleanupApplied: typeof payload.cleanupApplied === "boolean" ? payload.cleanupApplied : undefined,
    cleanupWarning: typeof payload.cleanupWarning === "string" ? payload.cleanupWarning.slice(0, 240) : undefined
  };
}

function summarizeTranscriptionResult(result) {
  return {
    id: result?.id,
    textLength: typeof result?.text === "string" ? result.text.length : undefined,
    rawTextLength: typeof result?.rawText === "string" ? result.rawText.length : undefined,
    cleanedTextLength: typeof result?.cleanedText === "string" ? result.cleanedText.length : undefined,
    wordCount: result?.wordCount,
    durationMs: result?.durationMs,
    transcriptionModel: result?.transcriptionModel,
    cleanupModel: result?.cleanupModel,
    cleanupTier: result?.cleanupTier,
    cleanupApplied: result?.cleanupApplied,
    fallbackUsed: result?.fallbackUsed,
    cleanupWarning: typeof result?.cleanupWarning === "string" ? result.cleanupWarning.slice(0, 240) : undefined
  };
}

function sanitizeRecordingMetadata(metadata) {
  if (!metadata || typeof metadata !== "object") {
    return {};
  }

  return {
    deviceId: typeof metadata.deviceId === "string" ? summarizeDeviceId(metadata.deviceId) : undefined,
    deviceLabel: typeof metadata.deviceLabel === "string" ? metadata.deviceLabel.slice(0, 120) : undefined,
    trackLabel: typeof metadata.trackLabel === "string" ? metadata.trackLabel.slice(0, 120) : undefined
  };
}

function summarizeDeviceId(deviceId) {
  if (!deviceId || deviceId === "default") {
    return deviceId || undefined;
  }

  return `${deviceId.slice(0, 8)}...${deviceId.slice(-4)}`;
}
