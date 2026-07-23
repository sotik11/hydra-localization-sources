/**
 * Per-source entry counts for the regenerate notification.
 *
 * The old summary was `git diff --stat | tail -1` ("8 files changed, 10984
 * insertions(+)"), which says nothing about which source actually moved —
 * every scheduled run rewrites whole JSON files, so the line counts are noise.
 *
 * Usage:
 *   node source-delta.mjs --snapshot <dataDir> <outFile>   # before regen
 *   node source-delta.mjs --report   <beforeFile> <dataDir> # after regen
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SKIP = new Set(["index.json", "steam-applist.json"]);

function countsOf(dataDir) {
  const out = {};
  for (const file of readdirSync(dataDir)) {
    if (!file.endsWith(".json") || SKIP.has(file)) continue;
    if (file.endsWith(".candidates.json")) continue;
    let n = 0;
    try {
      const doc = JSON.parse(readFileSync(join(dataDir, file), "utf8"));
      n = Array.isArray(doc.localizations) ? doc.localizations.length : 0;
    } catch {
      n = 0;
    }
    out[file.replace(/\.json$/, "")] = n;
  }
  return out;
}

const [mode, a, b] = process.argv.slice(2);

if (mode === "--snapshot") {
  writeFileSync(b, JSON.stringify(countsOf(a)), "utf8");
  process.exit(0);
}

if (mode !== "--report") {
  console.error("Usage: --snapshot <dataDir> <outFile> | --report <beforeFile> <dataDir>");
  process.exit(2);
}

let before = {};
try {
  before = JSON.parse(readFileSync(a, "utf8"));
} catch {
  before = {};
}
const after = countsOf(b);

// Telegram HTML parse_mode: only & < > need escaping, and it is the only mode
// besides MarkdownV2 that supports <u> — MarkdownV2 would mean escaping every
// ( ) - . + in the report, which is most of it.
const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const src = (name) => `<u>${esc(name)}</u>`;
const num = (n) => `<b>${esc(n)}</b>`;

const names = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
const changed = [];
const same = [];

for (const name of names) {
  const was = before[name];
  const now = after[name];

  if (was === undefined) {
    changed.push(`• ${src(name)} — новый источник (${num(now)})`);
  } else if (now === undefined) {
    changed.push(`• ${src(name)} — файл пропал (было ${num(was)})`);
  } else if (now !== was) {
    const d = now - was;
    changed.push(
      `• ${src(name)} — ${num(`${d > 0 ? "+" : ""}${d}`)} (${num(was)} → ${num(now)})`
    );
  } else {
    same.push(name);
  }
}

const total = Object.values(after).reduce((s, n) => s + n, 0);
const totalBefore = Object.values(before).reduce((s, n) => s + n, 0);
const totalDelta = total - totalBefore;

const lines = [];
if (changed.length) lines.push(...changed);
else lines.push("• изменений по источникам нет");
if (same.length)
  lines.push(`• без изменений: ${same.map(src).join(", ")}`);
lines.push("");
lines.push(
  `<u>Итого</u>: ${num(total)} записей (${num(`${totalDelta > 0 ? "+" : ""}${totalDelta}`)})`
);

console.log(lines.join("\n"));
