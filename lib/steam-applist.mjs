/**
 * Local Steam catalog index — full appid→name list, fetched once via the Steam
 * Web API (needs STEAM_WEBAPI_KEY in .env) and cached on disk.
 *
 * Why: `store.steampowered.com/api/storesearch/` hides delisted apps and
 * mis-ranks many popular titles. The Web API's IStoreService/GetAppList/v1
 * gives us the entire catalog — hundreds of thousands of apps — so a fuzzy
 * scan matches games storesearch flat-out refuses to return (Prototype 2,
 * Battlefield: Bad Company 2, X-Men Origins: Wolverine and friends).
 *
 * Public surface:
 *   - downloadAppList({ force }): scrape catalog to data/steam-applist.json
 *   - loadAppList(): read+prepare the in-memory index
 *   - resolveViaAppList(title): { appId, matchedName, score } or null
 *
 * The scoring reuses lib/steam-search.mjs' internals so the threshold
 * semantics stay identical across paths.
 */
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { UA, fetchTimeout, sleep } from "./net.mjs";
import { _internals } from "./steam-search.mjs";

const { norm } = _internals;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = join(ROOT, "data", "steam-applist.json");
const API = "https://api.steampowered.com/IStoreService/GetAppList/v1/";
const MAX_AGE_MS = 7 * 24 * 3600 * 1000; // 7 days — plenty for our use case

/* ------------------------------- downloader ------------------------------- */

export async function downloadAppList({ force = false } = {}) {
  if (!force && existsSync(CACHE) && Date.now() - statSync(CACHE).mtimeMs < MAX_AGE_MS) {
    console.log(`[applist] cache is fresh (${CACHE}) — skipping download`);
    return;
  }
  const key = process.env.STEAM_WEBAPI_KEY;
  if (!key) throw new Error("STEAM_WEBAPI_KEY missing — put it in .env");

  const apps = [];
  let lastAppid = 0;
  for (let page = 0; page < 40; page += 1) {
    const url = `${API}?key=${key}&format=json&max_results=50000&last_appid=${lastAppid}`;
    const res = await fetchTimeout(url, { headers: { Accept: "application/json", "User-Agent": UA } });
    if (!res.ok) throw new Error(`applist page ${page} → HTTP ${res.status}`);
    const json = await res.json();
    const list = json?.response?.apps || [];
    for (const a of list) if (a?.appid && a?.name) apps.push({ appid: a.appid, name: a.name });
    console.log(`[applist] page ${page}: +${list.length} (total ${apps.length})`);
    if (!json?.response?.have_more_results) break;
    lastAppid = json.response.last_appid;
    await sleep(200);
  }
  writeFileSync(CACHE, JSON.stringify(apps), "utf8");
  console.log(`[applist] wrote ${apps.length.toLocaleString()} apps → ${CACHE}`);
}

/* ------------------------------- in-memory -------------------------------- */

// Skip obvious non-game entries in the catalog — soundtracks, demos, betas,
// trailers, dedicated server packages, etc. Otherwise "Prototype 2" would
// happily match "Prototype 2 - Soundtrack" if only that survives.
const NON_GAME =
  /\b(soundtrack|ost\b|original\s+score|demo\b|beta\b|trailer|teaser|dedicated\s+server|test\s+server|sdk\b|tool\b|artbook|art\s+book|manual|wallpaper|movie\b|cinematic|behind[-\s]the[-\s]scenes|dlc\s+pack|season\s+pass|preorder|pre[-\s]?order)\b/i;

let INDEX = null;

export function loadAppList() {
  if (INDEX) return INDEX;
  if (!existsSync(CACHE)) throw new Error(`applist cache missing — run downloadAppList() first`);
  const raw = JSON.parse(readFileSync(CACHE, "utf8"));

  // Pre-normalize once; drop obvious non-game entries. Rows are indexed by
  // integer position so the inverted token index can use tiny Uint32Arrays.
  const rows = [];
  const byNorm = new Map();
  for (const a of raw) {
    if (NON_GAME.test(a.name)) continue;
    const n = norm(a.name);
    if (!n) continue;
    const idx = rows.length;
    rows.push({ appid: a.appid, name: a.name, n });
    const arr = byNorm.get(n);
    if (arr) arr.push(a.appid);
    else byNorm.set(n, [a.appid]);
    // Skip building tokenIndex here — we build it below in one pass to keep
    // this loop tight.
  }

  INDEX = { rows, byNorm };
  console.log(
    `[applist] indexed ${rows.length.toLocaleString()} apps ` +
      `(skipped ${raw.length - rows.length} non-game)`
  );
  return INDEX;
}

/* -------------------------------- resolver -------------------------------- */

// Prefer the LOWER appid when several apps share a normalized name — Valve
// reassigns names to remasters/collections higher up (Aliens: Colonial Marines
// original = 49540, "Collection" = higher). Lower id is almost always the
// original release we actually want to link to.
function pickLowest(ids) {
  return String(Math.min(...ids));
}

// Variants that are SAFE for applist lookup — they preserve the game's actual
// name (just clean noise), so an exact match is trustworthy. Excludes the
// first-N-words variants generateVariants() emits: those match "Race Driver"
// against "SHOFER Race Driver" and misroute the appid.
function safeVariantsForApplist(title) {
  const set = new Set();
  const push = (t) => { const s = (t || "").replace(/\s+/g, " ").trim(); if (s.length >= 2 && s.length <= 120) set.add(s); };
  const src = title;
  const stripParens = (t) => { let out = t, prev; do { prev = out; out = out.replace(/\s*\([^)]*\)\s*/g, " ").trim(); } while (out !== prev); return out; };
  const stripEd = (t) => t.replace(/[\s:.\-–—]+(the\s+)?(complete|deluxe|definitive|enhanced|gold|special|game\s+of\s+the\s+year|goty|ultimate|premium|collector.?s?|anniversary|remaster(?:ed)?|redux|director.?s?\s+cut|classic|revised|extended|full)(\s+edition)?\s*$/i, "").trim();
  const stripVer = (t) => t.replace(/[\s:.\-–—]+v\.?\s*\d+(?:\.\d+){0,3}\s*$/i, "").trim();
  const stripThe = (t) => t.replace(/^\s*(the|a|an|le|la|il|el)\s+/i, "");
  const flatten = (t) => t.replace(/[:_\-–—\/\\|]/g, " ").replace(/\s+/g, " ").trim();
  const romToAr = (t) => t.replace(/\b(i{1,3}|iv|v|vi{0,3}|ix|x|xi{0,2}|xiv|xv)\b/gi, (m) => {
    const map = {i:1,ii:2,iii:3,iv:4,v:5,vi:6,vii:7,viii:8,ix:9,x:10,xi:11,xii:12,xiii:13,xiv:14,xv:15};
    return String(map[m.toLowerCase()] || m);
  });
  const arToRom = (t) => t.replace(/\b(\d{1,2})\b/g, (m) => {
    const R = ["","I","II","III","IV","V","VI","VII","VIII","IX","X","XI","XII","XIII","XIV","XV"];
    const n = Number(m); return n >= 1 && n <= 15 ? R[n] : m;
  });
  const layers = [(t)=>t, stripParens, stripEd, stripVer, stripThe, flatten];
  for (const l1 of layers) for (const l2 of layers) push(l2(l1(src)));
  const cleaned = stripThe(stripEd(stripParens(src)));
  push(romToAr(cleaned)); push(arToRom(cleaned));
  push(flatten(romToAr(cleaned))); push(flatten(arToRom(cleaned)));
  return [...set];
}

/**
 * Resolves a title via the local Steam catalog index — exact-match only
 * (score 100). Returns { appId, matchedName, score } or null.
 *
 * Fuzzy scan against 172k names generates too many false positives, so we
 * only trust exact normalized matches here. The main resolveSteamAppId in
 * lib/steam-search.mjs still uses fuzzy scoring against storesearch's ~10
 * hit shortlist — that's a much safer place for fuzzy logic.
 */
export function resolveViaAppList(title, opts = {}) {
  const idx = loadAppList();
  const nt = norm(title);
  if (idx.byNorm.has(nt)) {
    return { appId: pickLowest(idx.byNorm.get(nt)), matchedName: title, score: 100 };
  }
  for (const v of safeVariantsForApplist(title)) {
    const nv = norm(v);
    if (nv === nt || !nv) continue;
    if (idx.byNorm.has(nv)) {
      return { appId: pickLowest(idx.byNorm.get(nv)), matchedName: v, score: 100 };
    }
  }
  return opts.returnCandidate ? { appId: null, matchedName: null, score: 0 } : null;
}
