const fs = require("node:fs");
const path = require("node:path");

const DEFAULTS = {
  cleanupTier: "standard",
  hotkey: "Control+Super",
  workerUrl: "http://127.0.0.1:8787"
};

function loadConfig(baseDir) {
  loadEnvFile(path.join(baseDir, ".env"));
  loadEnvFile(path.join(process.cwd(), ".env"));

  const config = {
    cleanupTier: normalizeCleanupTier(process.env.LARYN_CLEANUP_TIER),
    desktopToken: process.env.LARYN_DESKTOP_TOKEN || "",
    hotkey: process.env.LARYN_HOTKEY || DEFAULTS.hotkey,
    rendererUrl: process.env.LARYN_RENDERER_URL || "",
    workerUrl: normalizeUrl(process.env.LARYN_WORKER_URL || DEFAULTS.workerUrl)
  };

  logConfig(config);
  return config;
}

function normalizeCleanupTier(value) {
  return value === "cheap" || value === "premium" || value === "standard" ? value : DEFAULTS.cleanupTier;
}

function normalizeUrl(value) {
  try {
    return new URL(value).toString().replace(/\/$/, "");
  } catch {
    return DEFAULTS.workerUrl;
  }
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, equalsIndex).trim();
    const value = trimmed.slice(equalsIndex + 1).trim().replace(/^["']|["']$/g, "");
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function logConfig(config) {
  console.log("Laryn config:");
  console.log(`workerUrl=${config.workerUrl}`);
  console.log(`desktopToken=${config.desktopToken ? "present" : "missing"}`);
  console.log(`cleanupTier=${config.cleanupTier}`);
  console.log(`rendererUrl=${config.rendererUrl || "packaged"}`);
}

module.exports = {
  loadConfig,
  normalizeCleanupTier
};
