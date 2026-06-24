/**
 * Generator: Magyarítások Portál (magyaritasok.hu) -> data/magyaritasok.json
 *
 * The largest Hungarian fan-localization hub (Laravel + Livewire SPA). Two wins
 * make it a first-class source:
 *   - every game page embeds an EXACT Steam app id (store.steampowered.com/app/N)
 *   - each translation has a DIRECT download behind /download/<id>, which 302s
 *     to the real file on dl.magyaritasok.hu — the file path needs only a
 *     same-origin Referer (which Hydra's downloader + link probe already send).
 *
 * We page the /games catalogue, then per game read the translations table
 * ("thelist"): we keep only **Windows** rows whose link is a magyaritasok
 * /download/<id> page (Discord / forum / studio-site / video links are dropped),
 * resolve that to the real file URL, and emit one entry per game.
 *
 * The API/downloads are guarded — a bare request 302s to the homepage — so all
 * requests carry a browser User-Agent and a Referer; the catalogue/game pages
 * are server-rendered HTML, which is what we scrape.
 */
import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as cheerio from "cheerio";
import { UA, sleep, fetchTimeout, mapPool, getText } from "../lib/net.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const SITE = "https://magyaritasok.hu";

const STUDIO = "Magyarítások";
const LANGUAGE = "Magyar";

// How many catalogue pages to scan (env MH_MAX_PAGES for quick test runs).
const MAX_PAGES = Number(process.env.MH_MAX_PAGES) || Infinity;

// Our standard install guide, translated to Hungarian (used as the how-to).
const HOW_TO_INSTALL =
  `<ol>` +
  `<li>Töltsd le a magyarítást a fenti gombbal.</li>` +
  `<li>Ha telepítő (.exe), futtasd és kövesd a lépéseit; ` +
  `ha tömörített archívum, csomagold ki.</li>` +
  `<li>Másold a fájlokat a játék mappájába (ha rákérdez, írd felül).</li>` +
  `<li>Indítsd el a játékot — a magyarítás életbe lép. ` +
  `Néhány fordításnál a nyelvet a játék beállításaiban kell kiválasztani.</li>` +
  `</ol>`;

/* ----------------------------- catalogue index ---------------------------- */

function parseCatalogue(html) {
  const $ = cheerio.load(html);
  const games = [];
  const seen = new Set();
  $("a[href*='/games/']").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    const m = href.match(/\/games\/([a-z0-9-]+)/i);
    const name = $(el).text().replace(/\s+/g, " ").trim();
    if (!m || !name || seen.has(m[1])) return;
    seen.add(m[1]);
    games.push({ slug: m[1], name: name.replace(/\s*\(\d{4}\)\s*$/, "").trim() });
  });

  let lastPage = 1;
  $("a[href*='page=']").each((_, el) => {
    const m = ($(el).attr("href") ?? "").match(/page=(\d+)/);
    if (m) lastPage = Math.max(lastPage, Number(m[1]));
  });

  return { games, lastPage };
}

async function fetchCatalogue() {
  const first = parseCatalogue(await getText(`${SITE}/games?page=1`));
  const bySlug = new Map(first.games.map((g) => [g.slug, g]));
  const lastPage = Math.min(first.lastPage, MAX_PAGES);

  for (let page = 2; page <= lastPage; page += 1) {
    try {
      const { games } = parseCatalogue(await getText(`${SITE}/games?page=${page}`));
      for (const g of games) if (!bySlug.has(g.slug)) bySlug.set(g.slug, g);
    } catch (err) {
      console.warn(`\n  ! catalogue page ${page}: ${err.message}`);
    }
    await sleep(80);
  }
  return { games: [...bySlug.values()], pages: lastPage };
}

/* ------------------------------- game page -------------------------------- */

/** Resolves /download/<id> (the LETÖLTÉS action) to the real file URL. */
async function resolveFileUrl(id) {
  const action = `${SITE}/download/${id}`;
  try {
    const res = await fetchTimeout(action, {
      method: "GET",
      redirect: "follow",
      headers: {
        "User-Agent": UA,
        Referer: `${SITE}/`,
        Range: "bytes=0-0",
      },
    });
    // The guard 302s an unreferred request back to the homepage; a real file
    // ends on dl.magyaritasok.hu / magyaritasok.hu/dl/… with a 200/206.
    if ((res.status === 200 || res.status === 206) && /\/dl\/|dl\.magyaritasok/i.test(res.url)) {
      return res.url;
    }
  } catch {
    // unreachable -> treat as no direct file
  }
  return null;
}

/**
 * Pulls a version out of the resolved file name. Files are named either
 * "Game_HUN_1.46.exe" (dotted) or "Game_hunv18.exe" (v-prefixed) — prefer a
 * dotted number, fall back to a v-tag.
 */
function versionFromFile(url) {
  const file = decodeURIComponent((url || "").split("/").pop() || "");
  const dotted = file.match(/(\d+\.\d+(?:\.\d+)*)/);
  if (dotted) return dotted[1];
  const vtag = file.match(/v(\d+)/i);
  return vtag ? "v" + vtag[1] : null;
}

async function buildEntry(game) {
  const pageUrl = `${SITE}/games/${game.slug}`;
  const html = await getText(pageUrl);

  const appId = (html.match(/store\.steampowered\.com\/app\/(\d+)/) || [])[1];

  const tStart = html.indexOf("GAME TRANSLATIONS CONTAINER starts");
  const tEnd = html.indexOf("GAME TRANSLATIONS CONTAINER ends");
  if (tStart < 0) return null;
  const $ = cheerio.load(html.slice(tStart, tEnd > 0 ? tEnd : tStart + 40000));

  // First Windows row that has a magyaritasok /download/<id> link.
  let pick = null;
  $("table tbody tr").each((_, tr) => {
    if (pick) return;
    const $tr = $(tr);
    const windows = $tr
      .find("[title]")
      .toArray()
      .some((e) => /windows/i.test(e.attribs?.title || ""));
    if (!windows) return;
    const dl = $tr
      .find("a[href*='magyaritasok.hu/download/'], a[href^='/download/']")
      .first()
      .attr("href");
    const idMatch = (dl || "").match(/\/download\/(\d+)/);
    if (!idMatch) return; // only magyaritasok-hosted downloads (drops discord/site/video)

    const cells = $tr.find("td").toArray().map((td) => $(td).text().replace(/\s+/g, " ").trim());
    // Translators are linked to their profiles; fall back to a "( … )" cell.
    const byProfile = $tr
      .find("a[href*='/profile/']")
      .toArray()
      .map((a) => $(a).text().replace(/\s+/g, " ").trim())
      .filter(Boolean);
    const translators = byProfile.length
      ? byProfile.join(", ")
      : (cells.find((c) => /\(.+\)/.test(c)) || "")
          .replace(/^.*\(([^)]*)\).*$/, "$1")
          .trim();
    const statusText = cells.join(" ");
    pick = {
      id: idMatch[1],
      translators,
      inDevelopment: /Folyamatban|Tervbe véve/i.test(statusText),
    };
  });

  if (!pick) return null;

  const fileUrl = await resolveFileUrl(pick.id);
  if (!fileUrl) return null; // no reachable direct file -> skip

  return {
    steamAppId: appId ?? undefined,
    title: game.name,
    studio: pick.translators || STUDIO,
    studioUrl: SITE,
    language: LANGUAGE,
    hasText: true,
    hasVoice: false,
    version: versionFromFile(fileUrl),
    updatedAt: null,
    pageUrl,
    howToInstallHtml: HOW_TO_INSTALL,
    inDevelopment: pick.inDevelopment,
    mirrors: [{ label: STUDIO, url: fileUrl, kind: "direct" }],
  };
}

/* ---------------------------------- main ---------------------------------- */

async function main() {
  console.log("[MH] fetching catalogue…");
  const { games, pages } = await fetchCatalogue();
  console.log(`[MH] ${games.length} games across ${pages} catalogue pages`);

  // Each game needs two fetches (page + file resolve); a fixed pool turns the old
  // ~73-min sequential crawl into a few minutes without hammering the site.
  let scanned = 0;
  let kept = 0;
  const built = await mapPool(games, 5, async (game) => {
    let entry = null;
    try {
      entry = await buildEntry(game);
    } catch (err) {
      console.warn(`\n  ! ${game.slug}: ${err.message}`);
    }
    scanned += 1;
    if (entry) kept += 1;
    if (scanned % 25 === 0 || scanned === games.length)
      process.stdout.write(`\r[MH] scanned ${scanned}/${games.length}, kept ${kept}        `);
    return entry;
  });
  const localizations = built.filter(Boolean);
  console.log("");

  const file = { name: STUDIO, language: LANGUAGE, category: "aggregator", siteUrl: SITE, localizations };
  await mkdir(join(ROOT, "data"), { recursive: true });
  const outPath = join(ROOT, "data", "magyaritasok.json");
  await writeFile(outPath, JSON.stringify(file, null, 2), "utf8");

  const withAppId = localizations.filter((l) => l.steamAppId).length;
  const withVersion = localizations.filter((l) => l.version).length;
  const inDev = localizations.filter((l) => l.inDevelopment).length;
  console.log(`[MH] done → ${outPath}`);
  console.log(
    `[MH] total=${localizations.length}, steam-appid=${withAppId}, version=${withVersion}, in-dev=${inDev}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
