/**
 * Generator: Komunitní překlady (komunitni-preklady.org) -> data/komunitni-preklady.json
 *
 * Czech & Slovak community translation portal. The list of translations comes
 * from /sitemap.xml (advertised in robots.txt): every /preklad/<slug> with its
 * <lastmod>. Each translation page carries a JSON-LD SoftwareApplication
 * (softwareVersion, fileSize, dateModified, downloadUrl) plus HTML for the game
 * version and the translation type badge ("Ruční" vs AI).
 *
 * Incremental: data/komunitni-preklady.state.json keeps slug -> {lastmod, entry};
 * only pages that are new or whose lastmod moved are fetched (~30-70 a week
 * instead of ~830 requests for a full walk, which made CrowdSec ban us mid-run).
 * Without a state file it is seeded from the current feed as of SEED_LASTMOD.
 *   FULL=1   ignore the state and fetch every page (slow and ban-prone!)
 *
 * Download: /download/<id>?sig=... — the signature is REQUIRED (404 without it).
 * Taken as a direct in-app mirror (the sig is fresh each run); if it turns out to
 * be short-lived the UI falls back to "open in browser".
 *
 * Category: aggregator -> authorsHtml = the team. Modal content (install) stays
 * in the translation's own language (cs/sk); mirror labels are UI language.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { UA, sleep, fetchTimeout, mapPool, getText, normalizeSize } from "../lib/net.mjs";
import { resolveSteamAppIdWithScore } from "../lib/steam-search.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const SITE = "https://komunitni-preklady.org";
const FEED = join(ROOT, "data", "komunitni-preklady.json");
const STATE = join(ROOT, "data", "komunitni-preklady.state.json");
const FULL = process.env.FULL === "1";
// Date of the last complete crawl behind the committed feed (751 entries) —
// used once, to seed the state when there is no state file yet.
const SEED_LASTMOD = "2026-09-29";

const STUDIO = "Komunitní překlady";
const LANG_NAME = { cs: "Čeština", sk: "Slovenčina" };

const ROMAN = /^(?:i{1,3}|iv|vi{0,3}|ix|xi{0,2})$/i;
/** Last-resort name when the page has no VideoGame block: "a-b-ii" -> "A B II". */
const deslugify = (slug) =>
  slug
    .replace(/-(?:sk|cs)$/i, "")
    .replace(/-+$/g, "")
    .split("-")
    .filter(Boolean)
    .map((w) => (ROMAN.test(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(" ");

// Standard install note (we don't scrape the long per-translation guide), in the
// translation's own language — content language rule.
const HOW_TO_INSTALL = {
  cs:
    `<p>Každý překlad má vlastní postup instalace. Otevřete stránku překladu ` +
    `(tlačítko „Otevřít v prohlížeči“ níže) — najdete tam úplný návod k instalaci ` +
    `i tlačítko ke stažení.</p>`,
  sk:
    `<p>Každý preklad má vlastný postup inštalácie. Otvorte stránku prekladu ` +
    `(tlačidlo „Otvoriť v prehliadači“ nižšie) — nájdete tam úplný návod na ` +
    `inštaláciu aj tlačidlo na stiahnutie.</p>`,
};


const strip = (s) =>
  (s || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

const isoToDate = (iso) => {
  const m = (iso || "").match(/(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : null;
};

/* ------------------------------ polite fetch ------------------------------ */
// The site sits behind CrowdSec, which bans an IP for "suspicious behaviour" —
// i.e. our own crawl when it is too fast or too long — and counts every request
// made while banned as more of the same. So: one worker, a 2 s gap before each
// request, only the pages that changed, and the FIRST 403 aborts the whole run.

const POOL = 1;
const GAP_MS = 2000;

class BlockedError extends Error {}
let blocked = false;

async function politeGet(url, ms = 8000) {
  if (blocked) throw new BlockedError("run aborted: the site is blocking this IP");
  await sleep(GAP_MS);
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await getText(url, { tries: 1, ms });
    } catch (err) {
      if (/->\s*403\b/.test(err.message)) {
        blocked = true;
        throw new BlockedError(`403 on ${url} — IP blocked (CrowdSec), aborting the run`);
      }
      if (attempt >= 2 || /->\s*4\d\d\b/.test(err.message)) throw err; // 4xx: no retry
      await sleep(2000);
    }
  }
}

/* ----------------------------- catalogue index ---------------------------- */

/** Every translation in the sitemap: Map slug -> lastmod ("YYYY-MM-DD" or null). */
async function fetchSitemap() {
  const xml = await politeGet(`${SITE}/sitemap.xml`, 30000);
  const slugs = new Map();
  for (const [, block] of xml.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const slug = (block.match(/<loc>[^<]*\/preklad\/([a-z0-9-]+)\/?<\/loc>/i) || [])[1];
    if (!slug) continue;
    slugs.set(slug, (block.match(/<lastmod>(\d{4}-\d{2}-\d{2})/) || [])[1] || null);
  }
  return slugs;
}

/** slug -> {lastmod, entry}; seeded from the committed feed when there is no state. */
async function readState() {
  if (FULL) return {};
  try {
    return JSON.parse(await readFile(STATE, "utf8"));
  } catch {}
  try {
    const feed = JSON.parse(await readFile(FEED, "utf8"));
    const seeded = {};
    for (const entry of feed.localizations) {
      const slug = (entry.pageUrl.match(/\/preklad\/([a-z0-9-]+)/i) || [])[1];
      if (slug) seeded[slug] = { lastmod: SEED_LASTMOD, entry };
    }
    console.log(`[komunitni-preklady] no state — seeded ${Object.keys(seeded).length} from the feed as of ${SEED_LASTMOD}`);
    return seeded;
  } catch {
    return {};
  }
}

/* ------------------------------- file page -------------------------------- */

function buildEntry(slug, html) {
  const url = `${SITE}/preklad/${slug}`;

  const ld = (re) => (html.match(re) || [])[1] || null;
  const version = ld(/"softwareVersion":"([^"]+)"/);
  const size = normalizeSize(ld(/"fileSize":"([^"]+)"/));
  const updatedAt = isoToDate(ld(/"dateModified":"([^"]+)"/));
  const downloadUrl = ld(/"downloadUrl":"([^"]+)"/)?.replace(/\\u0026/gi, "&") || null;
  // Clean game name from the VideoGame JSON-LD block (the SoftwareApplication's
  // "name" is "<lang> do hry <game>"; the site also stopped putting name right
  // after the @type, so the old match fell back to the slug for every entry).
  const name =
    strip((html.match(/"VideoGame","@id":"[^"]*","name":"([^"]+)"/i) || [])[1] || "") ||
    deslugify(slug);
  const team = ld(/"author":\{"@type":"Organization","name":"([^"]+)"/);

  const gameVer =
    strip((html.match(/Verze\s+hry[\s\S]{0,80}?<\/[a-z]+>\s*<[^>]*>([^<]{1,40})/i) || [])[1] || "") ||
    ld(/"gameVersion":"([^"]+)"/) ||
    null;

  // Type from the page's method badge class: method-rucni (human) vs method-ai
  // (machine) / method-kombinace (machine + human correction) -> both neural.
  const neural = /method-(ai|kombinace)\b/.test(html);
  // Take the language from the TRANSLATION's JSON-LD block (#translation), not the
  // first "inLanguage" on the page — the site now emits a site-level cs block
  // first, which would mislabel every Slovak translation as Czech.
  const lang =
    (html.match(/#translation[^"]*"[\s\S]*?"inLanguage":"([a-z]{2})"/i) || [])[1] || "cs";

  const mirrors = downloadUrl ? [{ label: STUDIO, url: downloadUrl, kind: "direct" }] : [];

  return {
    title: name,
    studio: STUDIO,
    studioUrl: url,
    language: LANG_NAME[lang] || "Čeština",
    hasText: !neural,
    hasVoice: false,
    hasTextures: false,
    hasNeuralVoice: false,
    hasNeuralDub: false,
    hasNeuralText: neural,
    version,
    updatedAt,
    requiredGameVersion: gameVer,
    pageUrl: url,
    howToInstallHtml: HOW_TO_INSTALL[lang] || HOW_TO_INSTALL.cs,
    // Aggregator: the team is the author.
    authorsHtml: team ? `<p>${team}</p>` : null,
    size,
    // No released file -> still in development.
    inDevelopment: !downloadUrl,
    mirrors,
  };
}

/* --------------------------- steam app id lookup -------------------------- */
// Uses the shared lib/steam-search.mjs helper — variant generation, 4-level
// fuzzy scoring, type=app filter.

/* ---------------------------------- main ---------------------------------- */

async function main() {
  console.log("[komunitni-preklady] reading sitemap…");
  const sitemap = await fetchSitemap();
  const prev = await readState();
  const known = Object.keys(prev).length;
  // An empty or cut-down sitemap must not shrink the feed (or the state).
  if (sitemap.size === 0 || (known && sitemap.size < known * 0.7)) {
    throw new Error(`sitemap lists ${sitemap.size} translations, ${known} known — refusing`);
  }

  const changed = [...sitemap]
    .filter(([slug, lastmod]) => !prev[slug] || !lastmod || lastmod > prev[slug].lastmod)
    .map(([slug]) => slug);
  // Known translations missing from the sitemap are not necessarily gone (seen
  // 2026-10-19: 21 of them, some pages alive) — re-check each one: 404/410 drops
  // it, a live page keeps it.
  const unlisted = Object.keys(prev).filter((slug) => !sitemap.has(slug));
  const todo = [...changed, ...unlisted];
  console.log(
    `[komunitni-preklady] ${sitemap.size} in sitemap: ${changed.length} new/changed, ` +
      `${unlisted.length} known but unlisted — ${todo.length} pages to fetch`
  );

  const next = {};
  const gone = new Set();
  let done = 0;
  let failed = 0;
  const today = new Date().toISOString().slice(0, 10);
  await mapPool(todo, POOL, async (slug) => {
    try {
      const entry = buildEntry(slug, await politeGet(`${SITE}/preklad/${slug}`));
      next[slug] = { lastmod: sitemap.get(slug) || prev[slug]?.lastmod || today, entry };
    } catch (err) {
      if (err instanceof BlockedError) throw err; // stop everything, now
      if (/->\s*(?:404|410)\b/.test(err.message)) {
        gone.add(slug);
      } else {
        failed += 1;
        console.warn(`\n  ! ${slug}: ${err.message}`);
      }
    }
    done += 1;
    if (done % 10 === 0 || done === todo.length)
      process.stdout.write(`\r[komunitni-preklady] page ${done}/${todo.length}     `);
  });
  console.log("");

  // A handful of dead pages is normal; a lot of them is a throttled run, and a
  // partial feed must not be written over a full one.
  if (failed > Math.max(3, todo.length * 0.05)) {
    throw new Error(`${failed}/${todo.length} translation pages failed — refusing a partial feed`);
  }

  // Sitemap order, then the live unlisted ones; unchanged pages (and a page that
  // failed to load this time) keep their previous entry; 404/410 pages drop out.
  const state = {};
  for (const slug of [...sitemap.keys(), ...unlisted]) {
    const item = gone.has(slug) ? null : next[slug] || prev[slug];
    if (item) state[slug] = item;
  }
  if (gone.size) console.log(`[komunitni-preklady] removed (404/410): ${[...gone].join(", ")}`);
  const built = Object.values(state).map((item) => item.entry);
  for (const e of built) delete e.steamAppId; // re-resolved below

  const appCache = new Map();
  const resolveCached = (title) => {
    const key = title.toLowerCase();
    if (!appCache.has(key)) appCache.set(key, resolveSteamAppIdWithScore(title));
    return appCache.get(key);
  };
  const candidates = [];
  const seenCandidates = new Set();
  let j = 0;
  await mapPool(built, 5, async (e) => {
    const r = await resolveCached(e.title);
    if (r?.appId && r.score >= 60) e.steamAppId = r.appId;
    if ((!r?.appId || r.score < 100) && !seenCandidates.has(e.title)) {
      seenCandidates.add(e.title);
      candidates.push({
        title: e.title,
        appId: r?.appId ?? null,
        matched: r?.matchedName ?? null,
        score: r?.score ?? 0,
      });
    }
    j += 1;
    if (j % 25 === 0 || j === built.length)
      process.stdout.write(`\r[komunitni-preklady] appid ${j}/${built.length}     `);
  });
  console.log("");

  await mkdir(join(ROOT, "data"), { recursive: true });
  await writeFile(
    FEED,
    JSON.stringify(
      { name: STUDIO, language: "Čeština", category: "aggregator", siteUrl: SITE, localizations: built },
      null,
      2
    ),
    "utf8"
  );
  await writeFile(STATE, JSON.stringify(state), "utf8");

  const appid = built.filter((l) => l.steamAppId).length;
  const inDev = built.filter((l) => l.inDevelopment).length;
  const neural = built.filter((l) => l.hasNeuralText).length;
  const sk = built.filter((l) => l.language === "Slovenčina").length;
  console.log(
    `[komunitni-preklady] done → ${built.length} (appid=${appid}, in-dev=${inDev}, neural=${neural}, sk=${sk})`
  );

  await writeFile(
    join(ROOT, "data", "komunitni-preklady.candidates.json"),
    JSON.stringify(candidates, null, 2),
    "utf8"
  );
  const nulls = candidates.filter((c) => !c.appId).length;
  const low = candidates.filter((c) => c.appId && c.score < 100).length;
  console.log(
    `[komunitni-preklady] candidates → nulls=${nulls}, sub-100=${low} (written to data/komunitni-preklady.candidates.json)`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
