/**
 * Generator: Graj Po Polsku (grajpopolsku.pl) -> data/gpp.json
 *
 * GrajPoPolsku is a Polish fan-localization hub built on WordPress + WP Download
 * Manager. Unlike MVO/LBK it offers a DIRECT, in-app downloadable file: each
 * translation page has a `/?gppdl=<id>` link that 302-redirects to the actual
 * archive on their server. So we:
 *   1. page through /downloads/pc/            -> (slug, title) list
 *   2. fetch each /download/<slug>/           -> gppdl link, version, date, guide
 *   3. resolve the gppdl redirect to the real file URL (stable `direct` mirror)
 *   4. resolve a Steam app id by title (the site doesn't expose one)
 *
 * Per-page "Instalacja paczki" / "Instrukcja instalacji" steps are scraped into
 * howToInstallHtml; pages without that block fall back to a Polish rendering of
 * our standard install guide. Matching is by Steam app id, then title.
 */
import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as cheerio from "cheerio";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const SITE = "https://grajpopolsku.pl";
// The site 403s the default UA, so we present a normal browser string.
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const STUDIO = "Graj Po Polsku";
const STUDIO_URL = SITE;
const LANGUAGE = "Polski";

// Fallback install guide — our standard guide (localization_default_install_guide),
// translated to Polish — used when a page has no "Instalacja paczki" block.
const FALLBACK_INSTALL =
  `<ol>` +
  `<li>Pobierz archiwum spolszczenia, korzystając z jednego z powyższych źródeł.</li>` +
  `<li>Rozpakuj archiwum.</li>` +
  `<li>Skopiuj wypakowane pliki do folderu z zainstalowaną grą ` +
  `(zastąp pliki, jeśli pojawi się pytanie).</li>` +
  `<li>Uruchom grę — spolszczenie powinno zostać zastosowane. ` +
  `Niektóre spolszczenia pozwalają wybrać język w ustawieniach gry.</li>` +
  `</ol>`;

const PL_MONTHS = {
  stycznia: "01",
  lutego: "02",
  marca: "03",
  kwietnia: "04",
  maja: "05",
  czerwca: "06",
  lipca: "07",
  sierpnia: "08",
  września: "09",
  października: "10",
  listopada: "11",
  grudnia: "12",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getText(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.text();
}

async function getJson(url) {
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": UA },
  });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json();
}

/* ----------------------------- catalogue index ---------------------------- */

/** Reads (slug, title) pairs + the highest page number from one index page. */
function parseIndexPage(html) {
  const $ = cheerio.load(html);
  const games = [];
  $("a.featured-thumbnail[href*='/download/']").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    const m = href.match(/\/download\/([a-z0-9-]+)\//i);
    if (!m) return;
    games.push({ slug: m[1], title: ($(el).attr("title") ?? "").trim() });
  });

  let lastPage = 1;
  $("a[href*='/downloads/pc/page/']").each((_, el) => {
    const m = ($(el).attr("href") ?? "").match(/\/page\/(\d+)/);
    if (m) lastPage = Math.max(lastPage, Number(m[1]));
  });

  return { games, lastPage };
}

/** Pages through /downloads/pc/, deduped by slug. */
async function fetchCatalogue() {
  const first = parseIndexPage(await getText(`${SITE}/downloads/pc/`));
  const bySlug = new Map(first.games.map((g) => [g.slug, g]));

  for (let page = 2; page <= first.lastPage; page += 1) {
    try {
      const { games } = parseIndexPage(
        await getText(`${SITE}/downloads/pc/page/${page}/`)
      );
      for (const g of games) if (!bySlug.has(g.slug)) bySlug.set(g.slug, g);
    } catch (err) {
      console.warn(`\n  ! index page ${page} failed: ${err.message}`);
    }
    await sleep(120);
  }

  return { games: [...bySlug.values()], pages: first.lastPage };
}

/* ------------------------------- detail page ------------------------------ */

/** "v121" -> "1.2.1", "v10" -> "1.0" (the site drops dots in the filename). */
function versionFromFile(file) {
  const m = (file || "").match(/-v(\d+(?:[._]\d+)*)\.(?:zip|rar|7z|exe)$/i);
  if (!m) return null;
  let v = m[1].replace(/_/g, ".");
  if (/^\d+$/.test(v) && v.length > 1) v = v.split("").join(".");
  return v;
}

/** "15 czerwca 2024" -> "15.06.2024" */
function parsePolishDate(text) {
  const m = (text || "")
    .toLowerCase()
    .match(/(\d{1,2})\s+([a-ząćęłńóśźż]+)\s+(\d{4})/);
  if (!m) return null;
  const month = PL_MONTHS[m[2]];
  if (!month) return null;
  return `${m[1].padStart(2, "0")}.${month}.${m[3]}`;
}

/** Pulls the "Instalacja paczki" / "Instrukcja instalacji" block as HTML. */
function extractInstall($) {
  let html = null;
  $("h1,h2,h3,h4,h5,h6,strong,b,p").each((_, el) => {
    if (html) return;
    const heading = $(el).text().replace(/\s+/g, " ").trim();
    if (heading.length > 40) return;
    if (!/^(Instalacja|Instrukcja instalacji|Jak zainstalowa)/i.test(heading))
      return;
    const list = $(el).nextAll("ol,ul").first();
    if (!list.length) return;
    html =
      `<p><strong>${heading}</strong></p>` + ($.html(list) ?? "").trim();
  });
  return html;
}

/** Reads a "meta-title" box's trailing value text (after its icon). */
function metaValue($, label) {
  let value = null;
  $("span.meta-title").each((_, el) => {
    if (value) return;
    if ($(el).text().trim().toLowerCase() !== label.toLowerCase()) return;
    value = $(el).parent().text().replace($(el).text(), "").trim() || null;
  });
  return value;
}

/**
 * Follows the gppdl 302 to the real file URL without downloading the body.
 * The Location is sometimes absolute (…/wp-content/uploads/…) and sometimes
 * root-relative (/dwn/…/Game_PL.exe) — we resolve both against the gppdl base so
 * the stored mirror is the actual file (a clean filename for auto-extract). The
 * /dwn/ files are hotlink-protected and need a Referer, which the in-app
 * downloader and the link probe both send (see localization-download-manager).
 */
async function resolveDirectUrl(gppdlUrl) {
  try {
    const res = await fetch(gppdlUrl, {
      method: "GET",
      redirect: "manual",
      headers: { "User-Agent": UA, Referer: `${SITE}/`, Range: "bytes=0-0" },
    });
    const loc = res.headers.get("location");
    if (loc) return new URL(loc, gppdlUrl).href;
  } catch {
    // fall through to the gppdl URL itself
  }
  return gppdlUrl;
}

async function buildEntry(game) {
  const pageUrl = `${SITE}/download/${game.slug}/`;
  const $ = cheerio.load(await getText(pageUrl));

  const title = $("h1.single-title").first().text().trim() || game.title;

  const dl = $('a[href*="gppdl="]').first();
  const gppdlHref = dl.attr("href");
  const file = dl.attr("download") ?? "";

  let mirrors = [];
  if (gppdlHref) {
    const gppdlUrl = new URL(gppdlHref, SITE).href;
    const url = await resolveDirectUrl(gppdlUrl);
    mirrors = [{ label: "Graj Po Polsku", url, kind: "direct" }];
  }

  const updatedAt =
    parsePolishDate(metaValue($, "Aktualizacja")) ??
    parsePolishDate(metaValue($, "Data premiery"));

  // GrajPoPolsku is a subtitles-first site; dubbing projects are rare and tag
  // themselves in the file name, so default to text and flag voice from there.
  const hasVoice = /\bdub(bing)?\b/i.test(file) || /\bdub(bing)?\b/i.test(title);

  const steamAppId = await resolveSteamAppId(title);

  return {
    steamAppId: steamAppId ?? undefined,
    title,
    studio: STUDIO,
    studioUrl: STUDIO_URL,
    language: LANGUAGE,
    hasText: !hasVoice,
    hasVoice,
    version: versionFromFile(file),
    updatedAt,
    pageUrl,
    howToInstallHtml: extractInstall($) ?? FALLBACK_INSTALL,
    inDevelopment: false,
    mirrors,
  };
}

/* --------------------------- steam app id lookup -------------------------- */

const STEAM_SEARCH = "https://store.steampowered.com/api/storesearch/";

function normalizeTitle(t) {
  return (t || "")
    .toLowerCase()
    .replace(/['’:.,!?®™&–—_-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripSuffix(t) {
  let prev;
  let out = t.trim();
  do {
    prev = out;
    out = out.replace(/\s*\([^)]*\)\s*$/, "").trim();
  } while (out !== prev);
  return out;
}

async function steamSearch(term) {
  try {
    const json = await getJson(
      `${STEAM_SEARCH}?term=${encodeURIComponent(term)}&cc=us&l=en`
    );
    return Array.isArray(json?.items) ? json.items : [];
  } catch {
    return [];
  }
}

async function resolveSteamAppId(title) {
  const variants = [...new Set([title, stripSuffix(title)])];
  const targets = new Set(variants.map(normalizeTitle));
  for (const term of variants) {
    const items = await steamSearch(term);
    const hit = items.find((it) => targets.has(normalizeTitle(it.name)));
    if (hit?.id) return String(hit.id);
    await sleep(200);
  }
  return null;
}

/* ---------------------------------- main ---------------------------------- */

async function main() {
  console.log("[GPP] fetching catalogue…");
  const { games, pages } = await fetchCatalogue();
  console.log(`[GPP] ${games.length} games across ${pages} index pages`);

  const localizations = [];
  let i = 0;
  for (const game of games) {
    i += 1;
    try {
      const entry = await buildEntry(game);
      localizations.push(entry);
      process.stdout.write(
        `\r[GPP] ${i}/${games.length} — ${entry.title.slice(0, 30)} ` +
          `(${entry.mirrors.length ? "direct" : "no-dl"})            `
      );
    } catch (err) {
      console.warn(`\n  ! ${game.slug} failed: ${err.message}`);
    }
    await sleep(120);
  }
  console.log("");

  const file = { name: STUDIO, language: LANGUAGE, category: "aggregator", siteUrl: SITE, localizations };
  await mkdir(join(ROOT, "data"), { recursive: true });
  const outPath = join(ROOT, "data", "gpp.json");
  await writeFile(outPath, JSON.stringify(file, null, 2), "utf8");

  const direct = localizations.filter((l) => l.mirrors.length > 0).length;
  const withVersion = localizations.filter((l) => l.version).length;
  const withDate = localizations.filter((l) => l.updatedAt).length;
  const withAppId = localizations.filter((l) => l.steamAppId).length;
  const withGuide = localizations.filter(
    (l) => l.howToInstallHtml !== FALLBACK_INSTALL
  ).length;
  const voice = localizations.filter((l) => l.hasVoice).length;
  console.log(`[GPP] done → ${outPath}`);
  console.log(
    `[GPP] total=${localizations.length}, direct=${direct}, version=${withVersion}, ` +
      `date=${withDate}, steam-appid=${withAppId}, page-guide=${withGuide}, voice=${voice}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
