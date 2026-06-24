/**
 * Generator: Lokalizace.net -> data/lokalizace.json
 *
 * Czech localization portal (Nuxt SSR). Catalogues:
 *   - /localizations?status=public&page=N      (released)
 *   - /localizations?status=translating&page=N (in progress)
 * Each page embeds a hydration object with everything we need:
 *   project { name, slug }, localization { status, teamName, files[], updates[] }.
 *
 * Download: the "cooldown" ("Stáhnout (59)") is a UI delay only — the endpoint
 * https://lokalizace.net/api/download/<fileId> serves the file directly (200,
 * Content-Disposition, no Referer). So we get a real IN-APP direct download.
 *
 * Several versions per game -> the newest is the direct download; older ones are
 * extra mirror rows labelled "Версия X" (UI language, NOT the Czech "Verze").
 * Category: aggregator -> authorsHtml = the translating team. Modal CONTENT
 * (install / changelog / authors) stays Czech; mirror labels are UI language.
 */
import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { UA, sleep, fetchTimeout, mapPool, getText } from "../lib/net.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const SITE = "https://lokalizace.net";

const STUDIO = "Lokalizace.net";
const LANGUAGE = "Čeština";

/** Decodes the <... escapes Nuxt uses inside string fields. */
const unescapeJs = (s) =>
  (s || "")
    .replace(/\\u003C/gi, "<")
    .replace(/\\u003E/gi, ">")
    .replace(/\\u0026/gi, "&")
    .replace(/\\"/g, '"')
    .replace(/\\\//g, "/")
    .replace(/\\n/g, " ");

/* ----------------------------- catalogue index ---------------------------- */

/** Walk ?status=<status>&page=N until a page yields no new translation slugs. */
async function fetchCatalogue(status) {
  const slugs = new Set();
  for (let page = 1; page <= 200; page += 1) {
    let html;
    try {
      html = await getText(`${SITE}/localizations?status=${status}&page=${page}`);
    } catch {
      break;
    }
    const before = slugs.size;
    for (const m of html.matchAll(/\/localizations\/([a-z0-9-]+)/gi)) {
      if (!["public", "translating"].includes(m[1])) slugs.add(m[1]);
    }
    process.stdout.write(`\r[lokalizace] ${status}: page ${page}, ${slugs.size} games     `);
    if (slugs.size === before) break;
    await sleep(60);
  }
  console.log("");
  return slugs;
}

/* ------------------------------- file page -------------------------------- */

const dateFromTs = (ts) => {
  const d = new Date(Number(ts));
  return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.${d.getFullYear()}`;
};

/** Parses the hydration object embedded in a translation page. */
function buildEntry(slug, html) {
  const url = `${SITE}/localizations/${slug}`;

  const name = (html.match(/name:"([^"]+)",slug:"/) || [])[1];
  if (!name) return null;
  const teamName = (html.match(/teamName:"([^"]+)"/) || [])[1] || null;
  const status = (html.match(/,status:"(public|translating|[a-z_]+)"/) || [])[1] || "";

  // Files: newest first. Each: id, version, fileName, fileSize, createdAt, size text.
  const files = [];
  for (const m of html.matchAll(
    /\{id:(\d+),version:"([^"]*)",fileName:"([^"]+)"[^}]*?fileSize:(\d+)[^}]*?createdAt:new Date\((\d+)\)[^}]*?fileSizeFormatted:"([^"]+)"\}/g
  )) {
    files.push({
      id: m[1],
      version: m[2],
      sizeBytes: Number(m[4]),
      createdAt: m[5],
      size: m[6].replace(/\s+/g, " ").trim(),
    });
  }

  // Newest version = the in-app direct download; older ones = extra mirror rows
  // labelled in the UI language ("Версия X"), not the Czech "Verze".
  const mirrors = files.map((f, i) => ({
    label: i === 0 ? STUDIO : `Версия ${f.version}`,
    url: `${SITE}/api/download/${f.id}`,
    kind: i === 0 ? "direct" : "other",
  }));

  // Changelog (updates[]) — kept Czech (source language), verbatim HTML.
  const updates = [...html.matchAll(/\{id:\d+,content:"((?:[^"\\]|\\.)*)"[^}]*?fileVersion:"([^"]*)"\}/g)].map(
    (m) => unescapeJs(m[1])
  );
  const changelogHtml = updates.length ? `<div>${updates.join("")}</div>` : null;

  // Install guide — the Czech FAQ answer ("Stáhněte ZIP… nebo CZManager…").
  const faq = html.match(/Jak nainstalovat[^"]*","acceptedAnswer":\{"@type":"Answer","text":"([^"]+)"/i);
  const howToInstallHtml = faq ? `<p>${faq[1].replace(/\\"/g, '"').trim()}</p>` : null;

  const newest = files[0] || null;
  return {
    title: name,
    studio: STUDIO,
    studioUrl: url,
    language: LANGUAGE,
    hasText: true,
    hasVoice: false,
    hasTextures: false,
    hasNeuralVoice: false,
    hasNeuralDub: false,
    hasNeuralText: false,
    version: newest?.version || null,
    updatedAt: newest ? dateFromTs(newest.createdAt) : null,
    pageUrl: url,
    howToInstallHtml,
    changelogHtml,
    // Aggregator: the translating team is the author.
    authorsHtml: teamName ? `<p>${teamName}</p>` : null,
    size: newest?.size || null,
    // In development when not public, or no released file yet.
    inDevelopment: status !== "public" || files.length === 0,
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
  for (const term of [...new Set([title, stripSuffix(title)])]) {
    try {
      const res = await fetchTimeout(`${STEAM_SEARCH}?term=${encodeURIComponent(term)}&cc=us&l=en`, {
        headers: { Accept: "application/json", "User-Agent": UA },
      });
      const json = await res.json();
      const target = normalizeTitle(term);
      const hit = (json?.items || []).find((it) => normalizeTitle(it.name) === target);
      if (hit?.id) return String(hit.id);
    } catch {
      /* ignore */
    }
  }
  return null;
}

/* ---------------------------------- main ---------------------------------- */

async function main() {
  console.log("[lokalizace] fetching catalogues…");
  const pub = await fetchCatalogue("public");
  const dev = await fetchCatalogue("translating");
  const slugs = [...new Set([...pub, ...dev])];
  console.log(`[lokalizace] ${pub.size} public + ${dev.size} translating = ${slugs.length} unique`);

  let done = 0;
  const built = (
    await mapPool(slugs, 4, async (slug) => {
      let entry = null;
      try {
        entry = buildEntry(slug, await getText(`${SITE}/localizations/${slug}`));
      } catch (err) {
        console.warn(`\n  ! ${slug}: ${err.message}`);
      }
      done += 1;
      if (done % 25 === 0 || done === slugs.length)
        process.stdout.write(`\r[lokalizace] page ${done}/${slugs.length}     `);
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
      process.stdout.write(`\r[lokalizace] appid ${j}/${built.length}     `);
  });
  console.log("");

  await mkdir(join(ROOT, "data"), { recursive: true });
  await writeFile(
    join(ROOT, "data", "lokalizace.json"),
    JSON.stringify(
      { name: STUDIO, language: LANGUAGE, category: "aggregator", siteUrl: SITE, localizations: built },
      null,
      2
    ),
    "utf8"
  );

  const appid = built.filter((l) => l.steamAppId).length;
  const inDev = built.filter((l) => l.inDevelopment).length;
  const multi = built.filter((l) => l.mirrors.length > 1).length;
  console.log(
    `[lokalizace] done → ${built.length} (appid=${appid}, in-dev=${inDev}, multi-version=${multi})`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
