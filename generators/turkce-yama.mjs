/**
 * Generator: Türkçe Yama (turkce-yama.com) -> data/turkce-yama.json
 *
 * A large Turkish (Türkçe) translation archive. The game-patch catalogue is
 * /kategori/oyun-yamalari/page/N; each game page (/<slug>-turkce-yama.htm) has a
 * clean info block:
 *   Eklenme: <date>  Çevirmen: <translator>  Boyut: <size>  Dosya: <file name>
 *
 * Download is BROWSER-ONLY: the "İndir" button POSTs to admin-ajax.php with a
 * Cloudflare Turnstile token (captcha) and only then returns a short-lived URL —
 * not resolvable from a script. So the mirror is the page itself ("other").
 *
 * Category: aggregator -> the card shows the portal ("Türkçe Yama"); the
 * Çevirmen (translator) goes into the Authors modal. The site is behind
 * Cloudflare, so pages are fetched with the system curl (getTextCurl); Steam's
 * storesearch is plain fetch. Modal content stays Turkish (the source language).
 */
import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { sleep, mapPool, getTextCurl as getText, getJson, normalizeSize } from "../lib/net.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const SITE = "https://turkce-yama.com";
const STUDIO = "Türkçe Yama";
const LANGUAGE = "Türkçe";

// Standard install note in the source language (Turkish) — every patch ships as
// a .rar/.exe the user runs against the game folder.
const HOW_TO_INSTALL =
  `<ol>` +
  `<li>Yama dosyasını yukarıdaki «İndir» butonuyla indirin.</li>` +
  `<li>Kurulum dosyasıysa (.exe) çalıştırın; arşivse (.rar/.zip) çıkartın.</li>` +
  `<li>Oyunun kurulu olduğu klasörü gösterin / dosyaları oraya kopyalayın.</li>` +
  `<li>Oyunu başlatın — Türkçe yama uygulanmış olacaktır.</li>` +
  `</ol>`;

const TR_MONTHS = {
  ocak: "01", şubat: "02", mart: "03", nisan: "04", mayıs: "05", haziran: "06",
  temmuz: "07", ağustos: "08", eylül: "09", ekim: "10", kasım: "11", aralık: "12",
};

/** "15 Mart 2026" -> "15.03.2026" */
function parseTrDate(text) {
  const m = (text || "").match(/(\d{1,2})\s+([a-zçğıöşü]+)\s+(\d{4})/i);
  if (!m) return null;
  const month = TR_MONTHS[m[2].toLowerCase()];
  return month ? `${m[1].padStart(2, "0")}.${month}.${m[3]}` : null;
}

const decodeEntities = (s) =>
  (s || "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/gi, " ");

/* ----------------------------- catalogue index ---------------------------- */

const GAME_LINK = /href="https:\/\/turkce-yama\.com\/([a-z0-9-]+-turkce-yama)\.htm"/gi;

/** Walk /kategori/oyun-yamalari/page/N until a page yields no new games. */
async function fetchCatalogue() {
  const slugs = new Set();
  const maxPages = Number(process.env.TY_MAX_PAGES) || 200;
  let fails = 0;
  for (let page = 1; page <= maxPages; page += 1) {
    let html;
    try {
      html = await getText(`${SITE}/kategori/oyun-yamalari/page/${page}`);
      fails = 0;
    } catch (err) {
      console.warn(`\n  ! catalogue page ${page}: ${err.message}`);
      fails += 1;
      if (fails >= 4) break;
      await sleep(2000);
      continue;
    }
    const before = slugs.size;
    for (const m of html.matchAll(GAME_LINK)) slugs.add(m[1]);
    process.stdout.write(`\r[TY] catalogue page ${page}, ${slugs.size} games     `);
    if (slugs.size === before) break; // past the last page (no new games)
    await sleep(60);
  }
  console.log("");
  return [...slugs].map((slug) => `${SITE}/${slug}.htm`);
}

/* ------------------------------- game page -------------------------------- */

/** Reads a "LABEL:</span> VALUE</div>" info-block field. */
function field(html, label) {
  const re = new RegExp(`${label}:\\s*</span>\\s*([^<]+?)\\s*<`, "i");
  const m = html.match(re);
  return m ? decodeEntities(m[1]).replace(/\s+/g, " ").trim() : null;
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
  for (const term of [...new Set([title, stripSuffix(title)])]) {
    try {
      const json = await getJson(`${STEAM_SEARCH}?term=${encodeURIComponent(term)}&cc=us&l=en`);
      const target = normalizeTitle(term);
      const hit = (json?.items || []).find((it) => normalizeTitle(it.name) === target);
      if (hit?.id) return String(hit.id);
    } catch {
      /* ignore */
    }
  }
  return null;
}

function buildEntry(pageUrl, html) {
  const h1 = decodeEntities((html.match(/<h1[^>]*>([^<]+)<\/h1>/i) || [])[1] || "").trim();
  // "Far Cry 3 Türkçe Yama" / "… Türkçe Dublaj" -> bare game name.
  const title = h1.replace(/\s+Türkçe\s+\S.*$/i, "").trim();
  if (!title) return null;

  const author = field(html, "Çevirmen");
  const blob = h1.toLowerCase();
  const hasVoice = /dublaj|seslendirme/.test(blob);

  return {
    title,
    studio: STUDIO,
    studioUrl: pageUrl,
    language: LANGUAGE,
    hasText: !hasVoice,
    hasVoice,
    hasTextures: false,
    hasNeuralVoice: false,
    hasNeuralDub: false,
    hasNeuralText: false,
    version: null,
    updatedAt: parseTrDate(field(html, "Eklenme")),
    pageUrl,
    howToInstallHtml: HOW_TO_INSTALL,
    authorsHtml: author ? `<p>${author}</p>` : null,
    size: normalizeSize(field(html, "Boyut")),
    inDevelopment: false,
    // Browser-only: the İndir download is gated behind a Cloudflare Turnstile.
    mirrors: [{ label: STUDIO, url: pageUrl, kind: "other" }],
  };
}

/* ---------------------------------- main ---------------------------------- */

async function main() {
  console.log("[TY] fetching catalogue…");
  const urls = await fetchCatalogue();
  console.log(`[TY] ${urls.length} games`);

  let done = 0;
  const built = (
    await mapPool(urls, 4, async (pageUrl) => {
      let entry = null;
      try {
        entry = buildEntry(pageUrl, await getText(pageUrl));
      } catch (err) {
        console.warn(`\n  ! ${pageUrl}: ${err.message}`);
      }
      done += 1;
      if (done % 25 === 0 || done === urls.length)
        process.stdout.write(`\r[TY] page ${done}/${urls.length}     `);
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
    if (j % 25 === 0 || j === built.length)
      process.stdout.write(`\r[TY] appid ${j}/${built.length}     `);
  });
  console.log("");

  await mkdir(join(ROOT, "data"), { recursive: true });
  await writeFile(
    join(ROOT, "data", "turkce-yama.json"),
    JSON.stringify(
      { name: STUDIO, language: LANGUAGE, category: "aggregator", siteUrl: SITE, localizations: built },
      null,
      2
    ),
    "utf8"
  );

  const appid = built.filter((l) => l.steamAppId).length;
  const withSize = built.filter((l) => l.size).length;
  const withAuthors = built.filter((l) => l.authorsHtml).length;
  console.log(
    `[TY] done → ${built.length} (appid=${appid}, size=${withSize}, authors=${withAuthors})`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
