/**
 * Sanity-check every data/*.json in `stable` against its counterpart in `main`
 * before we snapshot stable -> main. See DESIGN.md > "Ветки репозитория
 * hydra-localization-sources" for the policy.
 *
 * Thresholds (see DESIGN.md):
 *   - count(stable) >= 90% of count(main)          — protects against empty parse
 *   - appid-coverage(stable) >= 60%                — protects against resolver regression
 *   - fileSize(stable) >= 50% of fileSize(main)    — protects against truncation on merge
 *
 * Output:
 *   - Exit 0 + prints "OK: ..." lines when all files pass
 *   - Exit 1 + prints "FAIL: <file>: <reason>" lines otherwise
 *   - Writes JSON summary to $GITHUB_OUTPUT (for Telegram notifier)
 */
import { readdirSync, readFileSync, statSync, existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const STABLE_DIR = process.argv[2];
const MAIN_DIR = process.argv[3];

if (!STABLE_DIR || !MAIN_DIR) {
  console.error("Usage: node sanity-check.mjs <stable-data-dir> <main-data-dir>");
  process.exit(2);
}

const COUNT_MIN_RATIO = 0.9;
const APPID_MIN_RATIO = 0.6;
const SIZE_MIN_RATIO = 0.5;

const files = readdirSync(STABLE_DIR).filter(
  (f) => f.endsWith(".json") && f !== "index.json" && f !== "steam-applist.json"
);

const failures = [];
const successes = [];

for (const file of files) {
  const stablePath = join(STABLE_DIR, file);
  const mainPath = join(MAIN_DIR, file);

  let stableData;
  try {
    stableData = JSON.parse(readFileSync(stablePath, "utf8"));
  } catch (e) {
    failures.push({ file, reason: `stable JSON parse failed: ${e.message}` });
    continue;
  }

  const stableEntries = Array.isArray(stableData?.localizations)
    ? stableData.localizations
    : null;
  if (!stableEntries) {
    failures.push({ file, reason: "stable has no `localizations` array" });
    continue;
  }

  const stableCount = stableEntries.length;
  const stableAppidCount = stableEntries.filter((e) => e && e.steamAppId).length;
  const stableAppidRatio = stableCount === 0 ? 0 : stableAppidCount / stableCount;
  const stableSize = statSync(stablePath).size;

  // If main doesn't have this file yet (new source added to stable) — no
  // baseline to compare against. Accept, we'll snapshot it into main first time.
  if (!existsSync(mainPath)) {
    successes.push({
      file,
      note: "new file (not yet in main)",
      count: stableCount,
      appidRatio: stableAppidRatio.toFixed(3),
      size: stableSize,
    });
    continue;
  }

  let mainData;
  try {
    mainData = JSON.parse(readFileSync(mainPath, "utf8"));
  } catch (e) {
    // main is broken? still snapshot stable — nothing to lose.
    successes.push({
      file,
      note: `main JSON invalid (${e.message}), overwriting`,
      count: stableCount,
      appidRatio: stableAppidRatio.toFixed(3),
      size: stableSize,
    });
    continue;
  }

  const mainEntries = Array.isArray(mainData?.localizations)
    ? mainData.localizations
    : [];
  const mainCount = mainEntries.length;
  const mainSize = statSync(mainPath).size;

  // Threshold 1: count ratio
  if (mainCount > 0 && stableCount / mainCount < COUNT_MIN_RATIO) {
    failures.push({
      file,
      reason: `count ${stableCount} < ${Math.round(
        mainCount * COUNT_MIN_RATIO
      )} (90% of main's ${mainCount}) — parser regression?`,
    });
    continue;
  }

  // Threshold 2: appid coverage
  if (stableAppidRatio < APPID_MIN_RATIO) {
    failures.push({
      file,
      reason: `appid coverage ${(stableAppidRatio * 100).toFixed(
        1
      )}% < ${APPID_MIN_RATIO * 100}% — resolver regression?`,
    });
    continue;
  }

  // Threshold 3: file size ratio
  if (mainSize > 0 && stableSize / mainSize < SIZE_MIN_RATIO) {
    failures.push({
      file,
      reason: `size ${stableSize}B < ${Math.round(
        mainSize * SIZE_MIN_RATIO
      )}B (50% of main's ${mainSize}B) — truncation?`,
    });
    continue;
  }

  successes.push({
    file,
    count: stableCount,
    appidRatio: stableAppidRatio.toFixed(3),
    size: stableSize,
  });
}

const summary = {
  ok: failures.length === 0,
  checkedFiles: files.length,
  passed: successes.length,
  failed: failures.length,
  failures,
  successes,
};

console.log(JSON.stringify(summary, null, 2));

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `summary<<EOF\n${JSON.stringify(summary)}\nEOF\n`
  );
  appendFileSync(process.env.GITHUB_OUTPUT, `ok=${summary.ok}\n`);
}

process.exit(summary.ok ? 0 : 1);
