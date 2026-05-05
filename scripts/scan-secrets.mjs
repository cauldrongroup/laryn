#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename } from "node:path";
import { execFileSync } from "node:child_process";

const args = new Set(process.argv.slice(2));
const scanHistory = args.has("--history");
const includeIgnored = args.has("--include-ignored");

const skipPathPattern =
  /(^|\/)(node_modules|\.git|\.turbo|\.wrangler|dist|dist-electron|release|out|coverage)(\/|$)|\.(png|jpe?g|gif|ico|lock|svg|webp)$/i;
const envFilePattern = /(^|\/)(\.env($|\.)|\.dev\.vars($|\.))/i;
const sensitiveKeyPattern = /(^|_)(SECRET|TOKEN|API_KEY|ACCESS_KEY|PRIVATE_KEY|CLIENT_SECRET|PASSWORD|PASSWD|CREDENTIAL)(_|$)/i;
const ignoredLocalPattern = /(^|\/)(logs\/|\.env($|\.)|\.dev\.vars($|\.))/i;
const placeholderPattern =
  /^(your_|replace_|example|placeholder|changeme|change_me|dummy|test|sandbox|<|\$\{\{|missing-|00000000-0000-0000-0000-000000000000)/i;

const rules = [
  ["Private key block", /-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/],
  ["GitHub token", /gh[pousr]_[A-Za-z0-9_]{36,}|github_pat_[A-Za-z0-9_]{80,}/],
  ["AWS access key id", /A(?:KIA|SIA)[A-Z0-9]{16}/],
  ["Google API key", /AIza[0-9A-Za-z_-]{35}/],
  ["Slack token", /xox[baprs]-[0-9A-Za-z-]{10,}/],
  ["Stripe secret key", /sk_(?:live|test)_[0-9A-Za-z]{20,}/],
  ["OpenAI key", /sk-[A-Za-z0-9]{32,}/],
  ["Groq key", /gsk_[A-Za-z0-9]{20,}/],
  ["Cloudflare token-like value", /\b(?:cfu|v1\.0-)[A-Za-z0-9_-]{30,}\b/],
  ["Polar token-like value", /\bpolar_[A-Za-z0-9_-]{20,}\b/],
  ["JWT", /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/]
];

const historyMarkerPattern = "PRIVATE KEY|gh[pousr]_|github_pat_|AKIA|ASIA|AIza|xox[baprs]-|sk_(live|test)_|sk-|gsk_|cfu|v1\\.0-|polar_|eyJ";
const findings = [];
let scannedFiles = 0;
let scannedHistoryCommits = 0;

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function gitList(args) {
  return git(args)
    .split("\0")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizePath(path) {
  return path.replaceAll("\\", "/");
}

function shouldSkip(path) {
  return skipPathPattern.test(normalizePath(path));
}

function isPlaceholder(value) {
  return placeholderPattern.test(value.trim());
}

function fingerprint(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function addFinding(scope, file, line, rule, key, value) {
  findings.push({
    scope,
    file: normalizePath(file),
    line,
    rule,
    key: key || "",
    fingerprint: value ? fingerprint(value) : ""
  });
}

function scanContent(scope, file, content) {
  const normalized = normalizePath(file);
  const lines = content.split(/\r?\n/);
  const isEnvFile = envFilePattern.test(normalized) || basename(normalized).includes(".env");

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNumber = index + 1;

    if (isEnvFile) {
      const assignment = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$/);
      if (assignment) {
        const [, key, rawValue] = assignment;
        const value = rawValue.trim().replace(/^["']|["']$/g, "");
        if (sensitiveKeyPattern.test(key) && value && !isPlaceholder(value)) {
          addFinding(scope, normalized, lineNumber, "Sensitive env assignment", key, value);
        }
      }
    }

    for (const [name, pattern] of rules) {
      const match = line.match(pattern);
      if (match) {
        addFinding(scope, normalized, lineNumber, name, "", match[0]);
      }
    }
  }
}

function scanWorkingTree() {
  const trackedFiles = gitList(["ls-files", "-z"]).filter((file) => !shouldSkip(file));
  const untrackedFiles = gitList(["ls-files", "--others", "--exclude-standard", "-z"]).filter((file) => !shouldSkip(file));
  const ignoredFiles = includeIgnored ? collectIgnoredLocalFiles() : [];

  const scopedFiles = [
    ...trackedFiles.map((file) => ["tracked", file]),
    ...untrackedFiles.map((file) => ["untracked", file]),
    ...ignoredFiles.map((file) => ["ignored-local", file])
  ];

  for (const [scope, file] of scopedFiles) {
    if (!existsSync(file)) {
      continue;
    }

    const content = readFileSync(file, "utf8");
    scanContent(scope, file, content);
    scannedFiles += 1;
  }
}

function collectIgnoredLocalFiles() {
  const files = [];
  const roots = [".", "apps", "packages", "logs"].filter((root) => existsSync(root));

  for (const root of roots) {
    walkLocalFiles(root, files);
  }

  return [...new Set(files)].filter((file) => !shouldSkip(file) && ignoredLocalPattern.test(normalizePath(file)));
}

function walkLocalFiles(path, files) {
  const normalized = normalizePath(path);
  if (normalized !== "." && shouldSkip(normalized)) {
    return;
  }

  let stat;
  try {
    stat = statSync(path);
  } catch {
    return;
  }

  if (stat.isDirectory()) {
    for (const entry of readdirSync(path)) {
      walkLocalFiles(path === "." ? entry : `${path}/${entry}`, files);
    }
    return;
  }

  if (stat.isFile()) {
    files.push(path);
  }
}

function parseGitGrepLine(line) {
  const first = line.indexOf(":");
  const second = line.indexOf(":", first + 1);
  const third = line.indexOf(":", second + 1);
  if (first === -1 || second === -1 || third === -1) {
    return null;
  }

  return {
    commit: line.slice(0, first),
    file: line.slice(first + 1, second),
    line: Number(line.slice(second + 1, third)),
    content: line.slice(third + 1)
  };
}

function scanHistoryForHighConfidencePatterns(commit) {
  let output = "";
  try {
    output = git(["grep", "-I", "-n", "-E", "-e", historyMarkerPattern, commit, "--"]);
  } catch (error) {
    if (error.status === 1) {
      return;
    }

    throw error;
  }

  for (const rawLine of output.split(/\r?\n/).filter(Boolean)) {
    const hit = parseGitGrepLine(rawLine);
    if (!hit || shouldSkip(hit.file)) {
      continue;
    }

    for (const [name, pattern] of rules) {
      const match = hit.content.match(pattern);
      if (match) {
        addFinding(`history:${hit.commit.slice(0, 12)}`, hit.file, hit.line, name, "", match[0]);
      }
    }
  }
}

function scanHistoryForSensitiveEnvFiles(commit) {
  let files = [];
  try {
    files = git(["ls-tree", "-r", "--name-only", "-z", commit])
      .split("\0")
      .filter(Boolean)
      .filter((file) => !shouldSkip(file) && envFilePattern.test(normalizePath(file)));
  } catch {
    return;
  }

  for (const file of files) {
    let content = "";
    try {
      content = git(["show", `${commit}:${file}`]);
    } catch {
      continue;
    }

    scanContent(`history:${commit.slice(0, 12)}`, file, content);
  }
}

function scanHeadHistory() {
  const commits = git(["rev-list", "HEAD"])
    .split(/\r?\n/)
    .filter(Boolean);

  for (const commit of commits) {
    scanHistoryForHighConfidencePatterns(commit);
    scanHistoryForSensitiveEnvFiles(commit);
    scannedHistoryCommits += 1;
  }
}

scanWorkingTree();
if (scanHistory) {
  scanHeadHistory();
}

if (findings.length > 0) {
  console.error(`Secret scan failed with ${findings.length} redacted finding(s):`);
  console.error("scope\tfile\tline\trule\tkey\tfingerprint");
  for (const finding of findings.slice(0, 100)) {
    console.error(
      `${finding.scope}\t${finding.file}\t${finding.line}\t${finding.rule}\t${finding.key}\t${finding.fingerprint}`
    );
  }
  if (findings.length > 100) {
    console.error(`...and ${findings.length - 100} more finding(s).`);
  }
  process.exit(1);
}

console.log(
  `Secret scan passed. files=${scannedFiles}${scanHistory ? ` historyCommits=${scannedHistoryCommits}` : ""}${
    includeIgnored ? " includeIgnored=true" : ""
  }`
);
