/**
 * Generator: schote.biz (schote.biz) -> data/schote.json
 *
 * The German fan-localization archive: text and voice patches, subtitles and
 * menus, curated by hoster. The catalogue at /archiv-sprachdateien-deutschpatches
 * returns ALL games on one page (~1000), so we do a single scrape + then per-game
 * lookups. Each game page can carry multiple "Sprachpaket" blocks (STALKER has
 * Sprachausgabe + Texte separately) — we emit ONE entry per block, all sharing
 * the same steamAppId (that matches how the modal already lists variants for
 * magyaritasok / komunitni cs+sk).
 *
 * Downloads: many mirrors are file-locker containers (filecrypt.cc, Rapidgator,
 * 4shared, turbobit) — browser-only. But pixeldrain has a public direct API
 * (/api/file/<id>?download), so those mirrors become in-app direct downloads.
 * Archives are password-protected — the password ("www.schote.biz") is exposed
 * per-entry in the modal via the new archivePassword field.
 *
 * Category: aggregator -> Ersteller ("creator") goes into authorsHtml when the
 * page exposes it. Content flags are derived from the German header of each
 * pack ("Deutsche Stimmen" -> hasVoice, "Deutsche Texte" -> hasText, etc.).
 */
import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { sleep, mapPool, getText, normalizeSize } from "../lib/net.mjs";
import { resolveSteamAppIdWithScore } from "../lib/steam-search.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const SITE = "https://www.schote.biz";
const CATALOGUE_URL = `${SITE}/archiv-sprachdateien-deutschpatches`;

const STUDIO = "schote.biz";
const LANGUAGE = "Deutsch";

const HOW_TO_INSTALL = [
  `<p>Jeder Deutschpatch von schote.biz hat eine eigene Installationsanleitung — `,
  `öffne die Spielseite (Button „Im Browser öffnen" unten) und folge den Schritten dort. `,
  `Wenn das Archiv passwortgeschützt ist, wird das Passwort oberhalb der Downloads angezeigt.</p>`,
].join("");

const strip = (s) =>
  (s || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

// schote uses "-", "–", empty, "kein Passwort" for unprotected files. Some rows
// also stuff the password column with a comment instead of a password ("Nur
// Anleitung", "Part 1", "Link zum Discord", "Hoster: usersdrive"). Since real
// schote passwords are always a single word (usually a domain), we treat any
// value with whitespace as commentary and drop it.
const normalizePassword = (raw) => {
  const s = strip(raw);
  if (!s) return null;
  if (/^[-–—]+$/.test(s)) return null;
  if (/\s/.test(s)) return null;
  if (/^(kein|keine|keins|none|no)$/i.test(s)) return null;
  return s;
};

/* ----------------------------- catalogue index ---------------------------- */

async function fetchCatalogue() {
  const html = await getText(CATALOGUE_URL);
  const slugs = new Set();
  const RE = /\/archiv-sprachdateien-deutschpatches\/([a-z0-9][a-z0-9-]{0,120})(?=["'#/])/gi;
  for (const m of html.matchAll(RE)) slugs.add(m[1]);
  return [...slugs];
}

/* ------------------------------- game page -------------------------------- */

// pixeldrain.com/u/<id> -> pixeldrain.com/api/file/<id>?download (direct)
const pixeldrainDirect = (url) => {
  const m = url.match(/pixeldrain\.com\/u\/([A-Za-z0-9]+)/);
  return m ? `https://pixeldrain.com/api/file/${m[1]}?download` : null;
};

/** Guess the file's own hoster from a URL — used as the mirror label. */
function hosterFromUrl(url) {
  try {
    const host = new URL(url).host.replace(/^www\./, "").toLowerCase();
    if (host.includes("pixeldrain")) return "pixeldrain";
    if (host.includes("rapidgator")) return "Rapidgator";
    if (host.includes("4shared")) return "4shared";
    if (host.includes("turbobit")) return "Turbobit";
    if (host.includes("filecrypt")) return "Filecrypt";
    if (host.includes("mega.nz") || host.includes("mega.co.nz")) return "MEGA";
    if (host.includes("mediafire")) return "MediaFire";
    if (host.includes("drive.google")) return "Google Drive";
    if (host.includes("dropbox")) return "Dropbox";
    if (host.includes("moddb")) return "ModDB";
    return host;
  } catch {
    return "Download";
  }
}

/** Extract every download pack (accordion block) from a game page. */
function parsePacks(html) {
  const packs = [];
  const RE_PACK = /<div[^>]*data-expand="mirror\d+"[^>]*class="download-expand[^"]*"[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>([\s\S]*?)<\/table>/g;
  for (const m of html.matchAll(RE_PACK)) {
    const rawH3 = m[1];
    const body = m[2];

    // The h3 packs THREE things: the pack type ("Deutsche Stimmen…"), an optional
    // "Geeignet für: <version>" in a <sup>, and an optional Ersteller in a <sup>.
    // Split at the first <br> so the pack type stays clean, then dig <sup>s.
    const [typeHtml, tailHtml = ""] = rawH3.split(/<br\s*\/?>/i);
    const header = strip(typeHtml);
    const ersteller = (
      tailHtml.match(/Ersteller:\s*([^<\n]+?)\s*(?=<|$)/i) || []
    )[1];
    const suitedFor = (
      tailHtml.match(/Geeignet\s+f(?:&uuml;|ü)r:\s*([^<\n]+?)\s*(?=<|$)/i) || []
    )[1];

    // Each mirror row: <td><a class="download-expand__file-download" href="URL">
    //   <span class="material-icons">download_for_offline</span>LABEL</a></td>
    //   <td>size</td><td align="right">password</td>
    // The href often points at filecrypt.cc (a container), but the visible LABEL is
    // the real hoster (Rapidgator / 4shared / Turbobit) — keep that as the mirror name.
    const RE_ROW = /<a\s+class="download-expand__file-download"\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/td>\s*<td[^>]*>([^<]*)<\/td>\s*<td[^>]*>([^<]*)<\/td>/g;
    const rows = [];
    for (const r of body.matchAll(RE_ROW)) {
      // Strip the material-icons <span> first — its inner text is the icon name
      // ("download_for_offline"), not something we want in the mirror label.
      const labelHtml = r[2].replace(
        /<span[^>]*material-icons[^>]*>[\s\S]*?<\/span>/gi,
        ""
      );
      rows.push({
        url: r[1].trim(),
        siteLabel: strip(labelHtml),
        size: strip(r[3]),
        password: normalizePassword(r[4]),
      });
    }

    packs.push({
      header,
      erstellerHtml: ersteller ? `<p>${strip(ersteller)}</p>` : null,
      requiredGameVersion: suitedFor ? strip(suitedFor.replace(/&amp;/g, "&")) : null,
      rows,
    });
  }
  return packs;
}

/** Content flags from a pack header ("Deutsche Stimmen / Sprachausgabe, Menü…"). */
function flagsFromHeader(header) {
  const h = header.toLowerCase();
  // "texte" or "text" or "untertitel" or "menü/menu" → text
  const hasText = /\b(texte?|untertitel|men[uü])\b/.test(h);
  // "stimmen" or "sprachausgabe" or "vertonung" → voice
  const hasVoice = /\b(stimmen|sprachausgabe|vertonung|voice)\b/.test(h);
  return { hasText, hasVoice };
}

function buildEntries(slug, html) {
  const pageUrl = `${CATALOGUE_URL}/${slug}`;

  // Strip HTML comments up front — schote often leaves the Ersteller/version markup
  // commented out (<!-- <sup>Ersteller: X</sup> -->), and we don't want those to leak
  // into the parsed data.
  const cleanHtml = html.replace(/<!--[\s\S]*?-->/g, "");

  // Game title is in the ONE <h1> the page emits (before the archive markup).
  const title =
    strip((cleanHtml.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || "") ||
    slug.replace(/-/g, " ");

  const packs = parsePacks(cleanHtml);
  if (!packs.length) return [];

  const entries = [];
  for (const pack of packs) {
    if (!pack.rows.length) continue;

    // Pack's archive password comes straight from the site — no fallback: if the
    // "Passwort" column says the file isn't protected, we leave the field null so
    // the modal doesn't render a password row for it.
    const password = pack.rows.find((r) => r.password)?.password || null;

    // Aggregate size: schote lists a size per mirror row, but they mirror the
    // same archive, so any row's size works. Prefer the first non-empty one.
    const size = normalizeSize(pack.rows.find((r) => r.size)?.size || null);

    const mirrors = [];
    for (const row of pack.rows) {
      const label = row.siteLabel || hosterFromUrl(row.url);
      const direct = pixeldrainDirect(row.url);
      if (direct) {
        mirrors.push({ label, url: direct, kind: "direct" });
      } else {
        mirrors.push({ label, url: row.url, kind: "other" });
      }
    }

    const { hasText, hasVoice } = flagsFromHeader(pack.header);

    entries.push({
      title,
      studio: STUDIO,
      studioUrl: pageUrl,
      language: LANGUAGE,
      hasText,
      hasVoice,
      hasTextures: false,
      hasSongs: false,
      hasNeuralVoice: false,
      hasNeuralDub: false,
      hasNeuralText: false,
      version: null,
      updatedAt: null,
      requiredGameVersion: pack.requiredGameVersion,
      pageUrl,
      howToInstallHtml: HOW_TO_INSTALL,
      // Aggregator: the pack creator (when exposed) goes into authors.
      authorsHtml: pack.erstellerHtml,
      size,
      inDevelopment: false,
      archivePassword: password,
      mirrors,
    });
  }
  return entries;
}

/* --------------------------- steam app id lookup -------------------------- */
// Uses the shared lib/steam-search.mjs helper — variant generation, 4-level
// fuzzy scoring, type=app filter.

/* ---------------------------------- main ---------------------------------- */

async function main() {
  console.log("[schote] fetching catalogue…");
  const slugs = await fetchCatalogue();
  console.log(`[schote] ${slugs.length} games`);

  let done = 0;
  const nested = await mapPool(slugs, 4, async (slug) => {
    try {
      const entries = buildEntries(slug, await getText(`${CATALOGUE_URL}/${slug}`));
      done += 1;
      if (done % 25 === 0 || done === slugs.length)
        process.stdout.write(`\r[schote] page ${done}/${slugs.length}     `);
      return entries;
    } catch (err) {
      console.warn(`\n  ! ${slug}: ${err.message}`);
      done += 1;
      return [];
    }
  });
  console.log("");
  const built = nested.flat();

  // Resolve Steam app id once per unique title (some titles produce two entries
  // — Texte + Sprachausgabe — but they should map to the SAME appid).
  const appCache = new Map();
  const resolveCached = (title) => {
    const key = title.toLowerCase();
    if (!appCache.has(key)) appCache.set(key, resolveSteamAppIdWithScore(title));
    return appCache.get(key);
  };
  const candidates = [];
  const seenCandidates = new Set();
  let j = 0;
  await mapPool(built, 4, async (e) => {
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
      process.stdout.write(`\r[schote] appid ${j}/${built.length}     `);
  });
  console.log("");

  await mkdir(join(ROOT, "data"), { recursive: true });
  await writeFile(
    join(ROOT, "data", "schote.json"),
    JSON.stringify(
      {
        name: STUDIO,
        language: LANGUAGE,
        category: "aggregator",
        siteUrl: SITE,
        localizations: built,
      },
      null,
      2
    ),
    "utf8"
  );

  const appid = built.filter((l) => l.steamAppId).length;
  const direct = built.filter((l) =>
    l.mirrors.some((m) => m.kind === "direct")
  ).length;
  const withPwd = built.filter((l) => l.archivePassword).length;
  const withAuthors = built.filter((l) => l.authorsHtml).length;
  const withReqVer = built.filter((l) => l.requiredGameVersion).length;
  const multiPackGames = built.length - new Set(built.map((l) => l.title)).size;
  console.log(
    `[schote] done → ${built.length} entries (${slugs.length} games, ${multiPackGames} extra packs)` +
      ` | appid=${appid}, direct=${direct}, pwd=${withPwd}, authors=${withAuthors}, reqVer=${withReqVer}`
  );

  await writeFile(
    join(ROOT, "data", "schote.candidates.json"),
    JSON.stringify(candidates, null, 2),
    "utf8"
  );
  const nulls = candidates.filter((c) => !c.appId).length;
  const low = candidates.filter((c) => c.appId && c.score < 100).length;
  console.log(
    `[schote] candidates → nulls=${nulls}, sub-100=${low} (written to data/schote.candidates.json)`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
