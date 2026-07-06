/**
 * Smart Steam appid resolver — shared by every generator.
 *
 * Why: `store.steampowered.com/api/storesearch` needs a bit of coaxing to reach
 * high hit-rates on fan-translation feeds. Titles carry apostrophes, "The"
 * prefixes, edition suffixes, Roman/Arabic number swaps, dashes vs colons, and
 * language-specific noise. A strict `normalized === normalized` compare misses
 * 40-70% of titles that a human would call obvious matches.
 *
 * Strategy:
 * 1. Ask Steam a handful of query VARIANTS (original, no parens, no edition
 *    suffix, no leading "The", roman↔arabic swap, first 2-3 words). Steam
 *    ranks by relevance internally — we just widen the funnel.
 * 2. For every returned hit (filtered to type=app so soundtracks and demos
 *    don't slip in), SCORE it against the original title through a 4-level
 *    fuzzy ladder: exact normalized (100), substring (80), token-overlap ≥
 *    0.75 (60-80 scaled), Levenshtein ≤ 3 (40). Best score wins.
 * 3. Threshold: 60. Below that we return null. The best-but-below hit is
 *    still available via `resolveSteamAppIdWithScore` — the generators can
 *    log those to build a manual overrides list.
 *
 * The Steam storesearch tolerates ~1 request/sec cheerfully; we cap the whole
 * pipeline at mapPool=4 (per the fetch mixture) and generate at most ~8 variants
 * per title, so a 1000-game feed makes ~8000 requests over ~30 minutes worst-case
 * (usually far less — early exit on score=100 is common).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { UA, fetchTimeout } from "./net.mjs";

const STEAM_SEARCH = "https://store.steampowered.com/api/storesearch/";

/* ------------------------- manual overrides table ------------------------- */
// Loaded once at module import — small file (a few KB, grows over time),
// keeping it in memory keeps every lookup instantaneous.
const OVERRIDES = (() => {
  try {
    const path = join(
      dirname(fileURLToPath(import.meta.url)),
      "steam-overrides.json"
    );
    const raw = JSON.parse(readFileSync(path, "utf8"));
    // Drop the "// comment"-shaped keys we use for legibility; keep real entries.
    const clean = {};
    for (const [k, v] of Object.entries(raw)) {
      if (k.startsWith("//") || v === "") continue;
      clean[k] = v; // v is either a string appid or null (known-not-on-Steam)
    }
    return clean;
  } catch {
    return {};
  }
})();

/* ---------------------------- normalization -------------------------------- */

/** Aggressive normalization — used for scoring, not for querying Steam.
 *  - lowercase
 *  - drop apostrophes AND the 1-3 letters after them (`'s`, `'ll`, `'d`, `'re`)
 *    so "Alan Wake's American Nightmare" == "Alan Wake American Nightmare"
 *  - collapse punctuation to spaces */
const norm = (t) =>
  (t || "")
    .toLowerCase()
    .replace(/([a-zа-я])['’`][a-zа-я]{1,3}\b/gi, "$1")
    .replace(/['’`]/g, "")
    .replace(/[:.,!?®™&–—_\-\/\\|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/* --------------------------- variant generation --------------------------- */

const stripParens = (t) => {
  let out = t, prev;
  do {
    prev = out;
    out = out.replace(/\s*\([^)]*\)\s*/g, " ").trim();
  } while (out !== prev);
  return out;
};

// Common edition/version suffixes people bake into fan-patch titles.
const EDITION =
  /[\s:.\-–—]+(the\s+)?(complete|deluxe|definitive|enhanced|gold|special|game\s+of\s+the\s+year|goty|ultimate|premium|collector.?s?|anniversary|remaster(?:ed)?|redux|director.?s?\s+cut|classic|revised|extended|full)(\s+edition)?\s*$/i;
const stripEditionSuffix = (t) => t.replace(EDITION, "").trim();

const stripThePrefix = (t) => t.replace(/^\s*(the|a|an|le|la|il|el)\s+/i, "");

// Trailing "v1.4", "vX.Y.Z" — a translation version, not part of the title.
const stripTrailingVersion = (t) =>
  t.replace(/[\s:.\-–—]+v\.?\s*\d+(?:\.\d+){0,3}\s*$/i, "").trim();

const ROMAN_MAP = {
  i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10,
  xi: 11, xii: 12, xiii: 13, xiv: 14, xv: 15, xvi: 16, xvii: 17, xviii: 18,
  xix: 19, xx: 20,
};
// Match order matters: longer forms (xviii) MUST come before shorter ones (xv, xi)
// so the regex engine doesn't greedily grab a prefix and stop.
const romanToArabic = (t) =>
  t.replace(/\b(xviii|xvii|xvi|xiv|xix|xx|xv|xii|xiii|xi|x|ix|viii|vii|vi|iv|v|iii|ii|i)\b/gi, (m) => {
    const n = ROMAN_MAP[m.toLowerCase()];
    return n ? String(n) : m;
  });

const ARABIC_ROMAN = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X",
  "XI", "XII", "XIII", "XIV", "XV", "XVI", "XVII", "XVIII", "XIX", "XX"];
const arabicToRoman = (t) =>
  t.replace(/\b(\d{1,2})\b/g, (m) => {
    const n = Number(m);
    return n >= 1 && n <= 20 ? ARABIC_ROMAN[n] : m;
  });

// Steam's storesearch takes some queries literally — a dash between words
// zeroes out results ("S.T.A.L.K.E.R. - Clear Sky" -> 0 hits, but
// "S.T.A.L.K.E.R. Clear Sky" -> 1 hit). Replace common separators with spaces.
const flattenSeparators = (t) =>
  t.replace(/[:_\-–—\/\\|]/g, " ").replace(/\s+/g, " ").trim();

function generateVariants(title) {
  const set = new Set();
  const push = (t) => {
    const s = (t || "").replace(/\s+/g, " ").trim();
    if (s.length >= 2 && s.length <= 120) set.add(s);
  };
  const layers = [
    (t) => t,
    stripParens,
    stripEditionSuffix,
    stripTrailingVersion,
    stripThePrefix,
    flattenSeparators,
  ];
  const seed = title;
  // Every combination of layer applications (order doesn't matter for these).
  for (const l1 of layers) {
    for (const l2 of layers) push(l2(l1(seed)));
  }
  // Roman↔Arabic swaps applied to the cleaned-up form.
  const cleaned = stripThePrefix(stripEditionSuffix(stripParens(seed)));
  push(romanToArabic(cleaned));
  push(arabicToRoman(cleaned));
  push(flattenSeparators(romanToArabic(cleaned)));
  push(flattenSeparators(arabicToRoman(cleaned)));
  // Prefix trimming — first 2 or 3 words as a last resort (helps
  // long "X: Subtitle - Edition" titles find the base game).
  const words = flattenSeparators(cleaned).split(/\s+/);
  if (words.length > 3) push(words.slice(0, 3).join(" "));
  if (words.length > 2) push(words.slice(0, 2).join(" "));
  return [...set];
}

/* -------------------------------- scoring --------------------------------- */

function tokenSet(t) {
  // Keep single-char tokens too — numbers like "2", "3" carry meaning in
  // titles ("Dark Souls 2", "Half-Life 2"). Only drop empty strings.
  return new Set(norm(t).split(/\s+/).filter((w) => w.length >= 1));
}

function tokenOverlap(a, b) {
  const A = tokenSet(a);
  const B = tokenSet(b);
  if (!A.size || !B.size) return 0;
  let common = 0;
  for (const w of A) if (B.has(w)) common += 1;
  return common / Math.max(A.size, B.size);
}

/** Classic O(m*n) Levenshtein — the titles are short enough this is fine. */
function levenshtein(a, b) {
  const m = a.length,
    n = b.length;
  if (!m) return n;
  if (!n) return m;
  const d = Array.from({ length: m + 1 }, (_, i) => [i]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
    }
  }
  return d[m][n];
}

/** Extract series numbers (1..15 as Arabic or Roman) from a title, as a Set of
 *  normalized Arabic strings. Used to detect series mismatches like "III" vs
 *  "IV" — a substring match on the base name ("Age of Empires") would otherwise
 *  accept "Age of Empires IV" as a hit for our "Age of Empires III" title. */
function seriesNumbers(t) {
  const nums = new Set();
  const s = t || "";
  for (const m of s.matchAll(/\b(\d{1,2})\b/g)) {
    const n = Number(m[1]);
    if (n >= 1 && n <= 20) nums.add(String(n));
  }
  for (const m of s.matchAll(/\b(xviii|xvii|xvi|xiv|xix|xx|xv|xii|xiii|xi|x|ix|viii|vii|vi|iv|v|iii|ii|i)\b/gi)) {
    const n = ROMAN_MAP[m[1].toLowerCase()];
    if (n) nums.add(String(n));
  }
  return nums;
}

/** True when `query` names a series number (III, 3, etc.) that `steamName`
 *  contradicts. Cases:
 *    - query has no series number → never a conflict.
 *    - query has a number, steamName has none → CONFLICT
 *      ("Dying Light 2" must NOT match "Dying Light" — the first-N-words
 *       variant otherwise drops the "2" and scores 100 on the wrong app).
 *    - both sides have numbers and none overlap → CONFLICT
 *      ("Age of Empires III" vs "Age of Empires IV").
 *    - both sides have numbers and any overlap → no conflict. */
function seriesConflict(query, steamName) {
  const q = seriesNumbers(query);
  const s = seriesNumbers(steamName);
  if (!q.size && !s.size) return false;   // both un-numbered — fine
  if (!q.size || !s.size) return true;    // asymmetric — "The Sims" must not match "The Sims 4", and vice versa
  for (const n of q) if (s.has(n)) return false;   // any overlap = same series
  return true;                             // both numbered, disjoint — conflict
}

/** 4-level fuzzy score — 100 exact ▸ 80 substring ▸ 60-80 token overlap
 *  scaled ▸ 40 Levenshtein small. 0 means "not a match". */
function scoreMatch(query, steamName) {
  const q = norm(query);
  const s = norm(steamName);
  if (!q || !s) return 0;
  // Series-number sanity — reject "Age of Empires III" ↔ "Age of Empires IV".
  if (seriesConflict(query, steamName)) return 0;
  if (q === s) return 100;
  // Substring, but require a meaningful overlap — the short side must cover a
  // real chunk of the long side (otherwise "Battle" ⊂ "Battlefield Bad Company 2"
  // would win, or "Erica" ⊂ "American McGee Alice" via token soup).
  // Rule: shorter string must be ≥ 60% of the longer AND ≥ 5 chars.
  const shortLen = Math.min(q.length, s.length);
  const longLen = Math.max(q.length, s.length);
  const meaningful = shortLen >= 5 && shortLen / longLen >= 0.6;
  if (meaningful && s.includes(q)) return 85;
  if (meaningful && q.includes(s)) return 80;
  const overlap = tokenOverlap(query, steamName);
  if (overlap >= 0.75) return 60 + Math.round((overlap - 0.75) * 80); // 60..80
  if (q.length >= 6 && s.length >= 6) {
    const dist = levenshtein(q, s);
    const maxLen = Math.max(q.length, s.length);
    if (dist <= 3 && dist / maxLen <= 0.15) return 40;
  }
  return 0;
}

/* ------------------------------- search API ------------------------------- */

async function searchOnce(term) {
  try {
    const res = await fetchTimeout(
      `${STEAM_SEARCH}?term=${encodeURIComponent(term)}&cc=us&l=en`,
      { headers: { Accept: "application/json", "User-Agent": UA } }
    );
    const json = await res.json();
    // filter to real games — soundtracks, demos, videos, tools would score
    // high on identical names but aren't what fan-translation feeds target.
    return (json?.items || []).filter((it) => it?.type === "app" && it?.id);
  } catch {
    return [];
  }
}

/**
 * Resolves a title to a Steam appid. Returns the appid string or null.
 *
 * @param {string} title - the title as parsed from the source
 * @param {object} [opts]
 * @param {boolean} [opts.returnCandidate] - if true, always returns an object
 *   { appId, matchedName, score } even below the threshold — useful for
 *   generators that want to log candidates for a future overrides list.
 * @param {number}  [opts.threshold=60]    - minimum score to accept a match.
 */
export async function resolveSteamAppId(title, opts = {}) {
  const threshold = opts.threshold ?? 60;

  // Manual override wins over anything storesearch would return. Key by the
  // same `norm(title)` we use internally, so an override written as "Böse
  // Nachbarn" matches a source-parsed "Böse Nachbarn:" (trailing punct etc.).
  const overrideKey = norm(title);
  if (Object.prototype.hasOwnProperty.call(OVERRIDES, overrideKey)) {
    const appId = OVERRIDES[overrideKey]; // string appid, or null (known-not-on-Steam)
    const result = { appId, matchedName: "(manual override)", score: 100 };
    return opts.returnCandidate ? result : appId;
  }

  // Try the local Steam catalog index next — exact match against the full
  // ~170k app list (see lib/steam-applist.mjs). Bypassed silently if the
  // cache isn't downloaded yet.
  try {
    const { resolveViaAppList } = await import("./steam-applist.mjs");
    const hit = resolveViaAppList(title);
    if (hit?.appId) {
      const result = { appId: hit.appId, matchedName: hit.matchedName, score: hit.score };
      return opts.returnCandidate ? result : hit.appId;
    }
  } catch {
    // no cache / missing key — fall through to storesearch
  }

  const variants = generateVariants(title);
  let best = { appId: null, matchedName: null, score: 0 };

  for (const term of variants) {
    const games = await searchOnce(term);
    for (const game of games) {
      // Series-conflict guard on the ORIGINAL title, not just the variant.
      // The first-N-words variant of "Dying Light 2" is "Dying Light" —
      // that would exact-match appid 239140 without this check, hijacking
      // the sequel's link to the original game.
      if (seriesConflict(title, game.name)) continue;
      // Score TWICE: against the original title and against the variant we
      // used to reach this hit. Take the max — variants exist to widen the
      // net; if a variant matches perfectly (e.g. "Dark Souls II" == the
      // Steam name), the original title's score is often lower but the hit
      // is obviously the right one.
      const score = Math.max(
        scoreMatch(title, game.name),
        scoreMatch(term, game.name)
      );
      if (score > best.score) {
        best = { appId: String(game.id), matchedName: game.name, score };
      }
      if (best.score >= 100) break;
    }
    if (best.score >= 100) break;
  }

  if (opts.returnCandidate) return best;
  return best.score >= threshold ? best.appId : null;
}

/** Same as resolveSteamAppId but always returns the best candidate + its
 *  score, even when below threshold. Handy for building an overrides map. */
export function resolveSteamAppIdWithScore(title) {
  return resolveSteamAppId(title, { returnCandidate: true });
}

/** Exposed for unit-test style debugging from a REPL. */
export const _internals = { norm, generateVariants, scoreMatch, tokenOverlap, levenshtein };
