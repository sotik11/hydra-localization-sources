/**
 * Generator: HerníPřeklady (hernipreklady.cz) -> data/hernipreklady.json
 *
 * Czech game-translation aggregator (Joomla site). Catalogue `/seznam-prekladu`
 * lists ~189 translations; each page is server-rendered (curl sees everything):
 *   - title (page <title> "Hernipreklady.cz - <Game>")
 *   - "Verze překladu" (translation version), "Verze hry" (game version)
 *   - authors — an "Info:" block with roles (Překlad / Korektura / Testování …)
 *   - direct .zip via DPAttachments (`?task=attachment.download&id=N`), needs a
 *     same-origin Referer (handled by Hydra's Referer-fix) -> IN-APP download
 *   - NO .zip / "Stažení překladu" block  =>  translation still in development
 *
 * Category: aggregator -> we fill `authorsHtml` (per-translation credits).
 */
import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const SITE = "https://hernipreklady.cz";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const STUDIO = "HerníPřeklady";
const LANGUAGE = "Čeština";

// All HerníPřeklady releases ship as .exe installers, so the install guide is
// always the same (Czech): run the installer, it's fully automatic.
const HOW_TO_INSTALL =
  `<p><strong>Instalace:</strong><br>Postupujte podle pokynů instalátoru. ` +
  `Instalace je plně automatická.</p>`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** fetch with an abort timeout — one dead socket must not hang the whole run. */
async function fetchTimeout(url, opts = {}, ms = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Runs fn over items at a fixed concurrency, preserving order. */
async function mapPool(items, concurrency, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return out;
}

async function getText(url, tries = 2) {
  for (let t = 1; ; t += 1) {
    try {
      const res = await fetchTimeout(url, { headers: { "User-Agent": UA } });
      if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
      return res.text();
    } catch (err) {
      if (t >= tries) throw err;
      await sleep(300);
    }
  }
}

// Common named entities incl. the Czech diacritics the site uses.
const ENT = {
  amp: "&", nbsp: " ", quot: '"', apos: "'", lt: "<", gt: ">",
  aacute: "á", eacute: "é", iacute: "í", oacute: "ó", uacute: "ú", yacute: "ý",
  ccaron: "č", scaron: "š", zcaron: "ž", rcaron: "ř", ecaron: "ě", uring: "ů",
  dcaron: "ď", tcaron: "ť", ncaron: "ň",
  Aacute: "Á", Eacute: "É", Iacute: "Í", Oacute: "Ó", Uacute: "Ú",
  Ccaron: "Č", Scaron: "Š", Zcaron: "Ž", Rcaron: "Ř", Ecaron: "Ě",
};
const decodeEntities = (s) =>
  (s || "")
    .replace(/&([a-zA-Z]+);/g, (m, n) => ENT[n] ?? m)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));

const strip = (s) =>
  decodeEntities((s || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

/* ----------------------------- catalogue index ---------------------------- */

async function fetchCatalogue() {
  const html = await getText(`${SITE}/seznam-prekladu`);
  const slugs = [...new Set((html.match(/\/seznam-prekladu\/[a-z0-9-]+/gi) || []))];
  return slugs.map((s) => SITE + s);
}

/* ------------------------------- authors ---------------------------------- */

/**
 * Credits from the "Info:" block: a run of `<p><strong>Role: names</strong></p>`
 * up to the next `<hr>`. Modal CONTENT stays in the source language (Czech) —
 * only Hydra's UI chrome (the link/modal titles) is localized. So roles
 * (Překlad / Korektura / Testování …) are kept verbatim, not translated.
 */
function extractAuthors(html) {
  const info = html.search(/Info:\s*<\/strong>/i);
  if (info < 0) return null;
  const block = html.slice(info, (html.indexOf("<hr", info) + 1 || info + 1200) - 1 + 1);
  const rows = [...block.matchAll(/<strong>([^]*?)<\/strong>/gi)]
    .map((m) => strip(m[1]))
    .filter((s) => /:/.test(s) && !/^Info\b/i.test(s));
  const lines = [];
  for (const row of rows) {
    const idx = row.indexOf(":");
    const role = row.slice(0, idx).trim();
    // Names come from stripped <a> tags -> tidy the "Jetro , Ralph" spacing.
    const names = row.slice(idx + 1).replace(/\s+,/g, ",").replace(/\s+/g, " ").trim();
    if (!names) continue;
    lines.push(`<strong>${role}:</strong> ${names}`);
  }
  return lines.length ? `<p>${lines.join("<br>")}</p>` : null;
}

/* ---------------------------------- date ---------------------------------- */

// Both the nominative and the genitive (date) form of each Czech month.
const CZ_MONTHS = [
  ["leden", "ledna"],
  ["únor", "února"],
  ["březen", "března"],
  ["duben", "dubna"],
  ["květen", "května"],
  ["červen", "června"],
  ["červenec", "července"],
  ["srpen", "srpna"],
  ["září"],
  ["říjen", "října"],
  ["listopad", "listopadu"],
  ["prosinec", "prosince"],
];

// HerníPřeklady writes update dates with a weekday prefix ("pondělí 2. březen
// 2026"), newest
// first. Require that prefix so we don't grab a date from comments/footer.
const CZ_WEEKDAYS = "pondělí|úterý|středa|čtvrtek|pátek|sobota|neděle";

/** First (newest) "<weekday> D. month YYYY" on the page -> "DD.MM.YYYY". */
function extractDate(text) {
  const re = new RegExp(`(?:${CZ_WEEKDAYS})\\s+(\\d{1,2})\\.\\s*(\\p{L}+)\\s+(\\d{4})`, "iu");
  const m = text.match(re);
  if (!m) return null;
  const idx = CZ_MONTHS.findIndex((names) => names.includes(m[2].toLowerCase()));
  if (idx < 0) return null;
  return `${String(m[1]).padStart(2, "0")}.${String(idx + 1).padStart(2, "0")}.${m[3]}`;
}

/* ------------------------------- file page -------------------------------- */

function buildEntry(url, html) {
  const rawTitle = (html.match(/<title>([^<]+)<\/title>/i) || [])[1] || "";
  const title = strip(rawTitle).replace(/^Hernipreklady\.cz\s*[-–]\s*/i, "").trim();
  if (!title) return null;

  const version = (html.match(/Verze\s+překladu:\s*<\/span>\s*<span[^>]*>\s*([0-9][\w.]*)/i) ||
    html.match(/Verze\s+překladu:\s*([0-9][\w.]*)/i) ||
    [])[1] || null;

  // "Verze hry: 1.3.2 Patch 2, 1.3.2 Patch 1 i 1.3.2 (PC - Win)" — NOT "Verze
  // herního klienta: Steam", so match "Verze hry:" specifically.
  const gameVer = strip(
    (html.match(/Verze\s+hry:\s*<\/span>\s*<span[^>]*>([\s\S]{0,80}?)<\/span>/i) ||
      html.match(/Verze\s+hry:\s*([^<]{0,80})/i) ||
      [])[1] || ""
  ).replace(/\s*Verze\s+překladu.*$/i, "").trim() || null;

  // Direct .zip via DPAttachments — its presence means the translation is RELEASED.
  const dl = html.match(
    /class="dp-attachment__title">([^<]+)<\/span>\s*(?:<span class="dp-attachment__size">\[([^\]]+)\]<\/span>\s*)?<a href="([^"]*attachment\.download[^"]*)"/i
  );
  const downloadUrl = dl ? SITE + dl[3].replace(/&amp;/g, "&") : null;
  const size = dl?.[2] ? dl[2].replace(/\s+/g, " ").trim() : null;

  const mirrors = downloadUrl
    ? [{ label: STUDIO, url: downloadUrl, kind: "direct" }]
    : [];

  // The release date is its own element: <div class="dp-attachment__date">
  // pátek 14. únor 2025 - <author></div>. Anchor on that class (ASCII) and parse
  // the "<weekday> D. month YYYY" out of it.
  const dateEl = html.match(/class="dp-attachment__date">([^<]+)</i);
  const updatedAt = dateEl ? extractDate(strip(dateEl[1])) : null;

  return {
    title,
    studio: STUDIO,
    studioUrl: url,
    language: LANGUAGE,
    // HerníPřeklady ships text translations (Czech texts).
    hasText: true,
    hasVoice: false,
    hasTextures: false,
    hasNeuralVoice: false,
    hasNeuralDub: false,
    hasNeuralText: false,
    version,
    updatedAt,
    requiredGameVersion: gameVer,
    pageUrl: url,
    howToInstallHtml: HOW_TO_INSTALL,
    authorsHtml: extractAuthors(html),
    // No release file yet -> still in development.
    inDevelopment: !downloadUrl,
    size,
    mirrors,
  };
}

/* --------------------------- steam app id lookup -------------------------- */

const STEAM_SEARCH = "https://store.steampowered.com/api/storesearch/";
const normalizeTitle = (t) =>
  (t || "").toLowerCase().replace(/['’:.,!?®™&–—_-]/g, " ").replace(/\s+/g, " ").trim();
const stripSuffix = (t) => {
  let prev, out = t.trim();
  do {
    prev = out;
    out = out.replace(/\s*\([^)]*\)\s*$/, "").trim();
  } while (out !== prev);
  return out;
};

async function resolveSteamAppId(title) {
  const variants = [...new Set([title, stripSuffix(title)])];
  const targets = new Set(variants.map(normalizeTitle));
  for (const term of variants) {
    try {
      const res = await fetchTimeout(`${STEAM_SEARCH}?term=${encodeURIComponent(term)}&cc=us&l=en`, {
        headers: { Accept: "application/json", "User-Agent": UA },
      });
      const json = await res.json();
      const hit = (json?.items || []).find((it) => targets.has(normalizeTitle(it.name)));
      if (hit?.id) return String(hit.id);
    } catch {
      /* abort timeout turns a hung request into a miss, not a stall */
    }
  }
  return null;
}

/* ---------------------------------- main ---------------------------------- */

async function main() {
  console.log("[hernipreklady] fetching catalogue…");
  const urls = await fetchCatalogue();
  console.log(`[hernipreklady] ${urls.length} translations`);

  let done = 0;
  const built = (
    await mapPool(urls, 8, async (url) => {
      let entry = null;
      try {
        entry = buildEntry(url, await getText(url));
      } catch (err) {
        console.warn(`\n  ! ${url}: ${err.message}`);
      }
      done += 1;
      if (done % 20 === 0 || done === urls.length)
        process.stdout.write(`\r[hernipreklady] page ${done}/${urls.length}     `);
      return entry;
    })
  ).filter(Boolean);
  console.log("");

  const appCache = new Map();
  const resolveCached = (title) => {
    const key = title.toLowerCase();
    if (!appCache.has(key)) appCache.set(key, resolveSteamAppId(title));
    return appCache.get(key);
  };
  let j = 0;
  await mapPool(built, 5, async (e) => {
    const appid = await resolveCached(e.title);
    if (appid) e.steamAppId = appid;
    j += 1;
    if (j % 20 === 0 || j === built.length)
      process.stdout.write(`\r[hernipreklady] appid ${j}/${built.length}     `);
  });
  console.log("");

  await mkdir(join(ROOT, "data"), { recursive: true });
  await writeFile(
    join(ROOT, "data", "hernipreklady.json"),
    JSON.stringify(
      { name: STUDIO, language: LANGUAGE, category: "aggregator", siteUrl: SITE, localizations: built },
      null,
      2
    ),
    "utf8"
  );

  const appid = built.filter((l) => l.steamAppId).length;
  const dev = built.filter((l) => l.inDevelopment).length;
  const withAuthors = built.filter((l) => l.authorsHtml).length;
  console.log(
    `[hernipreklady] done → ${built.length} (appid=${appid}, in-dev=${dev}, авторы=${withAuthors})`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
