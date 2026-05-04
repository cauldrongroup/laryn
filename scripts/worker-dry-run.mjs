#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const pnpmCommand = process.env.npm_execpath ? process.execPath : process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const pnpmBaseArgs = process.env.npm_execpath ? [process.env.npm_execpath] : [];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    shell: false,
    ...options
  });

  if (result.error) {
    throw result.error;
  }

  return result;
}

function redactWranglerOutput(output) {
  return output.replace(/(env\.[A-Z0-9_]+\s+\(")[^"]+("\))/g, "$1<redacted>$2");
}

const build = run(pnpmCommand, [...pnpmBaseArgs, "--filter", "@laryn/dashboard", "build"], { stdio: "inherit" });
if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

const dryRun = run(pnpmCommand, [...pnpmBaseArgs, "--filter", "@laryn/worker", "exec", "wrangler", "deploy", "--dry-run"], {
  maxBuffer: 10 * 1024 * 1024
});

if (dryRun.stdout) {
  process.stdout.write(redactWranglerOutput(dryRun.stdout));
}
if (dryRun.stderr) {
  process.stderr.write(redactWranglerOutput(dryRun.stderr));
}

process.exit(dryRun.status ?? 0);
