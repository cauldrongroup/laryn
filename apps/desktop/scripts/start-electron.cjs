const { spawn } = require("node:child_process");
const electronPath = require("electron");
const { resolve } = require("node:path");

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const desktopDir = resolve(__dirname, "..");

const child = spawn(electronPath, ["dist-electron/main.cjs"], {
  cwd: desktopDir,
  env,
  stdio: "inherit"
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});
