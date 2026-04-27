const { copyFileSync, cpSync, existsSync, mkdirSync } = require("node:fs");
const { dirname, resolve } = require("node:path");

const desktopDir = resolve(__dirname, "..");
const outDir = resolve(desktopDir, "dist-electron");
const outFile = resolve(outDir, "main.cjs");

mkdirSync(dirname(outFile), { recursive: true });
copyFileSync(resolve(desktopDir, "main.cjs"), outFile);
copyFileSync(resolve(desktopDir, "config.cjs"), resolve(outDir, "config.cjs"));

const assetsDir = resolve(desktopDir, "assets");
if (existsSync(assetsDir)) {
  cpSync(assetsDir, resolve(outDir, "assets"), { recursive: true });
}
