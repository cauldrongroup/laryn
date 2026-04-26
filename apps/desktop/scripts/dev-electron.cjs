const { spawn } = require("node:child_process");
const { watch } = require("node:fs");
const { resolve } = require("node:path");
const electronPath = require("electron");
const { waitForResources } = require("./wait-for-resources.cjs");

const desktopDir = resolve(__dirname, "..");
const rendererUrl = process.env.LARYN_RENDERER_URL?.trim();

if (!rendererUrl) {
  throw new Error("LARYN_RENDERER_URL is required for hot Electron development.");
}

const renderer = new URL(rendererUrl);
const rendererPort = Number.parseInt(renderer.port, 10);
if (!Number.isInteger(rendererPort) || rendererPort <= 0) {
  throw new Error(`LARYN_RENDERER_URL must include an explicit port: ${rendererUrl}`);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

let child = null;
let restartTimer = null;
let shuttingDown = false;

function start() {
  if (shuttingDown || child) return;
  child = spawn(electronPath, ["dist-electron/main.cjs"], {
    cwd: desktopDir,
    env,
    stdio: "inherit"
  });
  child.once("exit", () => {
    child = null;
    if (!shuttingDown) scheduleRestart();
  });
}

function stop() {
  return new Promise((resolveStop) => {
    if (!child) {
      resolveStop();
      return;
    }
    const current = child;
    child = null;
    current.once("exit", resolveStop);
    current.kill();
    setTimeout(resolveStop, 1500).unref();
  });
}

function scheduleRestart() {
  if (shuttingDown) return;
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    void stop().then(start);
  }, 120);
}

async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (restartTimer) clearTimeout(restartTimer);
  watcher?.close();
  await stop();
  process.exit(code);
}

let watcher = null;

async function main() {
  await waitForResources({
    baseDir: desktopDir,
    files: ["dist-electron/main.cjs", "dist-electron/preload.cjs"],
    tcpHost: renderer.hostname,
    tcpPort: rendererPort
  });

  watcher = watch(resolve(desktopDir, "dist-electron"), (_event, filename) => {
    if (filename === "main.cjs" || filename === "preload.cjs") {
      scheduleRestart();
    }
  });

  start();
}

process.once("SIGINT", () => void shutdown(130));
process.once("SIGTERM", () => void shutdown(143));

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
