/**
 * Generator: Calypso Çeviri (calypsoceviri.com) -> data/calypsoceviri.json
 *
 * A Turkish translation TEAM (studio) on a Wix site. The catalogue is the Wix
 * "turkce-yamalar" collection, enumerated via its dynamic sitemap. Each game
 * page (/turkce-yamalar/<slug>-turkce-yama-indir) has:
 *   - a DIRECT .rar on the Wix CDN (/_files/archives/…) — real in-app download,
 *     its size read from the file's Content-Length,
 *   - "Emeği Geçenler" — the contributing team members (-> authorsHtml),
 *   - "Kurulum ve Yama Kaldırma" — Turkish install / uninstall steps.
 *
 * Category: studio (studio = "Calypso Çeviri"); the team members still go into
 * the Authors modal. Behind Cloudflare, so pages are fetched with the system
 * curl; Steam's storesearch is plain fetch.
 */
import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import {
  UA,
  sleep,
  mapPool,
  getTextCurl as getText,
  getJson,
  formatBytes,
} from "../lib/net.mjs";
import { resolveSteamAppIdWithScore } from "../lib/steam-search.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const SITE = "https://www.calypsoceviri.com";
const STUDIO = "Calypso Çeviri";
const LANGUAGE = "Türkçe";

const FALLBACK_INSTALL =
  `<p>İndirdiğiniz arşivdeki Türkçe Yama dosyasını oyunun kurulu olduğu klasöre ` +
  `atıp çalıştırın ve yamayı kurun.</p>`;

const decodeEntities = (s) =>
  (s || "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/gi, " ");

/** HEAD a Wix-CDN file (Cloudflare) and read its size from Content-Length. */
function fileSize(url) {
  return new Promise((resolve) => {
    execFile(
      "curl",
      ["-s", "-I", "-L", "-m", "20", "-A", UA, url],
      { maxBuffer: 4 * 1024 * 1024, encoding: "utf8" },
      (err, stdout) => {
        if (err) return resolve(null);
        const m = stdout.match(/content-length:\s*(\d+)/i);
        resolve(m ? formatBytes(Number(m[1])) : null);
      }
    );
  });
}

/* ----------------------------- catalogue index ---------------------------- */

/** The collection's item URLs (+ lastmod) live in a dynamic sitemap. */
async function fetchCatalogue() {
  const index = await getText(`${SITE}/sitemap.xml`);
  const dyn = (index.match(/<loc>([^<]*dynamic-turkce-yamalar[^<]*-sitemap\.xml)<\/loc>/i) || [])[1];
  if (!dyn) return [];
  const xml = await getText(dyn);
  const games = [];
  for (const m of xml.matchAll(
    /<loc>([^<]*turkce-yamalar\/[^<]+)<\/loc>(?:\s*<lastmod>([^<]+)<\/lastmod>)?/gi
  )) {
    games.push({ url: m[1].trim(), lastmod: (m[2] || "").trim() || null });
  }
  return games;
}

/* ------------------------------- game page -------------------------------- */

/** "Emeği Geçenler" team members (the <br>-separated names block). */
function extractAuthors(html) {
  const m = html.match(
    /Emeği Geçenler[\s\S]*?wixui-rich-text[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i
  );
  if (!m) return null;
  const names = m[1]
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .split("\n")
    .map((s) => decodeEntities(s).replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return names.length ? `<p>${names.join(", ")}</p>` : null;
}

/** "Kurulum ve Yama Kaldırma" install/uninstall copy (Turkish, source language). */
function extractInstall(html) {
  const i = html.search(/Kurulum ve Yama Kaldırma/i);
  if (i < 0) return null;
  // Drop the heading's own rich-text block, then take the next one (the copy).
  const after = html.slice(i).replace(/^[\s\S]*?Kurulum ve Yama Kaldırma[\s\S]*?<\/div>/i, "");
  const m = after.match(/wixui-rich-text[^>]*>([\s\S]*?)<\/div>/i);
  if (!m) return null;
  const body = m[1]
    .replace(/<\/p>/gi, "<br><br>")
    .replace(/<br\s*\/?>/gi, "<br>")
    .replace(/<(?!\/?br\b)[^>]*>/gi, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/(\s*<br>\s*){3,}/g, "<br><br>")
    .replace(/^(?:\s|<br>)+|(?:\s|<br>)+$/g, "")
    .trim();
  return body ? `<div>${decodeEntities(body)}</div>` : null;
}

/* --------------------------- steam app id lookup -------------------------- */
// Uses the shared lib/steam-search.mjs helper — variant generation, 4-level
// fuzzy scoring, type=app filter.

/* --------------------------------- entry ---------------------------------- */

async function buildEntry(game) {
  const html = await getText(game.url);
  const h1 = decodeEntities(
    (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1]?.replace(/<[^>]+>/g, " ") || ""
  )
    .replace(/\s+/g, " ")
    .trim();
  // "DEATH STRANDING 2 Türkçe Yama İndir" -> bare game name.
  const title = h1.replace(/\s*Türkçe\s+(?:Yama|Dublaj|Seslendirme)\b[\s\S]*$/i, "").trim();
  if (!title) return null;

  // Direct .rar on the Wix CDN; its size is the file's Content-Length.
  const rar = (html.match(/href="(https:\/\/www\.calypsoceviri\.com\/_files\/archives\/[^"]+)"/i) || [])[1];
  let size = null;
  let mirrors;
  if (rar) {
    size = await fileSize(rar);
    mirrors = [{ label: STUDIO, url: rar, kind: "direct" }];
  } else {
    mirrors = [{ label: STUDIO, url: game.url, kind: "other" }];
  }

  // Version from the download filename ("…Yama V2.rar"), if present.
  const dn = rar ? decodeURIComponent(decodeURIComponent(rar)) : "";
  const version = (dn.match(/\bv\.?\s?(\d+(?:\.\d+)*)/i) || [])[1] || null;
  const hasVoice = /dublaj|seslendirme/i.test(h1);

  return {
    title,
    studio: STUDIO,
    studioUrl: SITE,
    language: LANGUAGE,
    hasText: !hasVoice,
    hasVoice,
    hasTextures: false,
    hasNeuralVoice: false,
    hasNeuralDub: false,
    hasNeuralText: false,
    version,
    updatedAt: game.lastmod ? game.lastmod.split("-").reverse().join(".") : null,
    pageUrl: game.url,
    howToInstallHtml: extractInstall(html) || FALLBACK_INSTALL,
    authorsHtml: extractAuthors(html),
    size,
    inDevelopment: false,
    mirrors,
  };
}

/* ---------------------------------- main ---------------------------------- */

async function main() {
  console.log("[CC] fetching catalogue (sitemap)…");
  let games = await fetchCatalogue();
  if (process.env.CC_MAX) games = games.slice(0, Number(process.env.CC_MAX));
  console.log(`[CC] ${games.length} games`);

  let done = 0;
  const built = (
    await mapPool(games, 4, async (game) => {
      let entry = null;
      try {
        entry = await buildEntry(game);
      } catch (err) {
        console.warn(`\n  ! ${game.url}: ${err.message}`);
      }
      done += 1;
      if (done % 20 === 0 || done === games.length)
        process.stdout.write(`\r[CC] page ${done}/${games.length}     `);
      return entry;
    })
  ).filter(Boolean);
  console.log("");

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
    if (j % 20 === 0 || j === built.length)
      process.stdout.write(`\r[CC] appid ${j}/${built.length}     `);
  });
  console.log("");

  await mkdir(join(ROOT, "data"), { recursive: true });
  await writeFile(
    join(ROOT, "data", "calypsoceviri.json"),
    JSON.stringify(
      { name: STUDIO, language: LANGUAGE, category: "studio", siteUrl: SITE, localizations: built },
      null,
      2
    ),
    "utf8"
  );

  const appid = built.filter((l) => l.steamAppId).length;
  const direct = built.filter((l) => l.mirrors[0]?.kind === "direct").length;
  const withSize = built.filter((l) => l.size).length;
  const withAuthors = built.filter((l) => l.authorsHtml).length;
  console.log(
    `[CC] done → ${built.length} (appid=${appid}, direct=${direct}, size=${withSize}, authors=${withAuthors})`
  );

  await writeFile(
    join(ROOT, "data", "calypsoceviri.candidates.json"),
    JSON.stringify(candidates, null, 2),
    "utf8"
  );
  const nulls = candidates.filter((c) => !c.appId).length;
  const low = candidates.filter((c) => c.appId && c.score < 100).length;
  console.log(
    `[calypsoceviri] candidates → nulls=${nulls}, sub-100=${low} (written to data/calypsoceviri.candidates.json)`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
