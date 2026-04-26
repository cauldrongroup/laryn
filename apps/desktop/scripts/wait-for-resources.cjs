const { access } = require("node:fs/promises");
const net = require("node:net");
const { resolve } = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function tcpPortIsReady(host, port, timeoutMs = 500) {
  return new Promise((resolveReady) => {
    const socket = net.createConnection({ host, port });
    let settled = false;

    const finish = (ready) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolveReady(ready);
    };

    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.setTimeout(timeoutMs);
  });
}

async function waitForResources({ baseDir, files = [], tcpHost, tcpPort, timeoutMs = 120_000 }) {
  const startedAt = Date.now();

  while (true) {
    const pendingFiles = [];
    for (const file of files) {
      if (!(await fileExists(resolve(baseDir, file)))) {
        pendingFiles.push(file);
      }
    }

    const tcpReady = tcpPort ? await tcpPortIsReady(tcpHost || "127.0.0.1", tcpPort) : true;
    if (pendingFiles.length === 0 && tcpReady) {
      return;
    }

    if (Date.now() - startedAt >= timeoutMs) {
      const pending = [...pendingFiles.map((file) => `file:${file}`)];
      if (!tcpReady) pending.unshift(`tcp:${tcpHost || "127.0.0.1"}:${tcpPort}`);
      throw new Error(`Timed out waiting for Electron resources: ${pending.join(", ")}`);
    }

    await delay(100);
  }
}

module.exports = { waitForResources };
