/**
 * Generator: Ctrl+Trad (ctrltrad.itch.io) -> data/ctrltrad.json
 *
 * An Italian fan-translation studio hosting all their patches on itch.io. About
 * 86 modern PC games — Anno 2205, Aragami 2, Anima Flux, AI LIMIT, etc.
 *
 * Catalogue: the user page lists every project as a plain <a href> to
 * /<slug>. Each project page exposes a public `/data.json` endpoint that
 * returns { id, price, title, tags, cover_image, links, authors } — no auth
 * required. We pull that once per project instead of scraping the HTML.
 *
 * Downloads: itch.io's "Download Now" button is generated client-side (it
 * POSTs to /download-url and gets a signed URL back), so we can't hand Hydra
 * a direct file link from a script. Every mirror is therefore browser-only —
 * one entry pointing at the project page ("Open in browser"). No captcha, no
 * login: the user just clicks "Download Now" on the itch page.
 *
 * Category: studio -> Ctrl+Trad is one team, not an aggregator. Content is
 * text-only (Italian localisation of English/other-language games), so
 * hasText: true, hasVoice: false — the studio never dubs.
 *
 * Fetch mixture: getText / getJson (undici, tries=4 + backoff), mapPool=4,
 * fetchTimeout. itch.io is behind Cloudflare but its public JSON endpoints
 * are not fingerprint-gated for undici — plain fetch works.
 */
import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as cheerio from "cheerio";
import { sleep, mapPool, getText, getJson } from "../lib/net.mjs";
import { resolveSteamAppIdWithScore } from "../lib/steam-search.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const SITE = "https://ctrltrad.itch.io";
const STUDIO = "Ctrl+Trad";
const LANGUAGE = "Italiano";

const HOW_TO_INSTALL = [
  `<p>Ogni traduzione ha la propria procedura di installazione — apri la `,
  `pagina del progetto (pulsante « Apri nel browser » qui sotto), premi `,
  `« Download Now » su itch.io e segui le istruzioni indicate.</p>`,
].join("");

/** Strip the "Traduzione Italiana" / "TRADUZIONE ITALIANA" tail some titles
 *  carry — including anything the studio pins after it (versione, "v1.4",
 *  "VERSIONE GOG 1.26", edition markers), a trailing "vX.Y" version stamp,
 *  and a parenthesised "(… + Traduzione ITA)" note. Handles the "Traduzone"
 *  typo the studio sometimes leaves in.  */
function cleanTitle(raw) {
  return (raw || "")
    .replace(/\s+/g, " ")
    // "(Restyle + Traduzione ITA)" and similar parenthetical notes.
    .replace(/\s*\([^)]*trad(?:uz\w*e|\.?)\b[^)]*\)\s*$/i, "")
    // "- TRADUZIONE ITALIANA v1.4" / "- Traduzone Italiana v1.0.6" (typo).
    .replace(/[\s:.\-–—]+trad(?:uz\w*e|\.?)\s+italiana\b.*$/i, "")
    .replace(/[\s:.\-–—]+trad\.?\s*ita\.?\b.*$/i, "")
    // A dangling "v1.0" / "v.1.1" after the game name is a translation-version
    // tag, not part of the title — drop it.
    .replace(/\s+v\.?\s*\d+(?:\.\d+)*\s*$/i, "")
    .trim();
}

/** Some titles carry a translation version tag before the "Traduzione Italiana"
 *  suffix (e.g. "- TRADUZIONE ITALIANA v1.4", "- TRADUZIONE ITALIANA VERSIONE
 *  GOG 1.26"). Pull the version out so it lands in the modal's version row. */
function extractVersion(raw) {
  if (!raw) return null;
  // "v1.4", "v1.10.2" — the studio's most common pattern.
  const m = raw.match(/\bv[\s.]*(\d+(?:\.\d+)*)\b/i);
  if (m) return m[1];
  // "VERSIONE GOG 1.26" — GOG/Steam edition markers with a trailing number.
  const g = raw.match(/\bVERSIONE\s+[A-Z]+\s+(\d+(?:\.\d+)*)\b/i);
  return g ? g[1] : null;
}

/* ----------------------------- catalogue index ---------------------------- */

async function fetchCatalogue() {
  const html = await getText(`${SITE}/`);
  const $ = cheerio.load(html);
  const slugs = new Set();
  $("a[href]").each((_, el) => {
    const href = ($(el).attr("href") || "").trim();
    // Direct game link on this user's page: ctrltrad.itch.io/<slug> (no trailing path).
    const m = href.match(/^https:\/\/ctrltrad\.itch\.io\/([a-z0-9][a-z0-9-]{1,120})\/?$/i);
    if (m && m[1] !== "download") slugs.add(m[1]);
  });
  return [...slugs];
}

/* ------------------------------- project page ------------------------------ */

async function buildEntry(slug) {
  const pageUrl = `${SITE}/${slug}`;
  let data;
  try {
    data = await getJson(`${pageUrl}/data.json`);
  } catch (err) {
    console.warn(`\n  ! ${slug}: data.json ${err.message}`);
    return null;
  }

  const title = cleanTitle(data.title);
  if (!title) return null;
  const version = extractVersion(data.title);

  return {
    title,
    studio: STUDIO,
    studioUrl: SITE,
    language: LANGUAGE,
    hasText: true,
    hasVoice: false,
    hasTextures: false,
    hasSongs: false,
    hasNeuralVoice: false,
    hasNeuralDub: false,
    hasNeuralText: false,
    version,
    updatedAt: null,
    requiredGameVersion: null,
    pageUrl,
    // Same install snippet for every project — see comment above.
    howToInstallHtml: HOW_TO_INSTALL,
    authorsHtml: null,
    // itch.io hides the upload size behind the "Download Now" API dance, so
    // we can't surface it without emulating a browser session.
    size: null,
    inDevelopment: false,
    archivePassword: null,
    // One "browser-only" mirror pointing at the itch.io project page: the user
    // hits "Download Now" there. Kind: "other" so Hydra opens it externally.
    mirrors: [{ label: STUDIO, url: pageUrl, kind: "other" }],
  };
}

/* --------------------------- steam app id lookup -------------------------- */
// Uses the shared lib/steam-search.mjs helper — variant generation, 4-level
// fuzzy scoring (exact / substring / token overlap / Levenshtein), and a
// type=app filter that keeps soundtracks and demos out.

/* ---------------------------------- main ---------------------------------- */

async function main() {
  console.log("[ctrltrad] fetching catalogue…");
  const slugs = await fetchCatalogue();
  console.log(`[ctrltrad] ${slugs.length} projects`);

  let done = 0;
  const built = (
    await mapPool(slugs, 4, async (slug) => {
      const entry = await buildEntry(slug);
      done += 1;
      if (done % 10 === 0 || done === slugs.length)
        process.stdout.write(`\r[ctrltrad] page ${done}/${slugs.length}     `);
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
  const candidates = []; // low-score / null hits — for a future overrides list
  let j = 0;
  await mapPool(built, 4, async (e) => {
    const r = await resolveCached(e.title);
    if (r?.appId && r.score >= 60) e.steamAppId = r.appId;
    if (!r?.appId || r.score < 100) {
      candidates.push({
        title: e.title,
        appId: r?.appId ?? null,
        matched: r?.matchedName ?? null,
        score: r?.score ?? 0,
      });
    }
    j += 1;
    if (j % 10 === 0 || j === built.length)
      process.stdout.write(`\r[ctrltrad] appid ${j}/${built.length}     `);
  });
  console.log("");

  await mkdir(join(ROOT, "data"), { recursive: true });
  await writeFile(
    join(ROOT, "data", "ctrltrad.json"),
    JSON.stringify(
      {
        name: STUDIO,
        language: LANGUAGE,
        category: "studio",
        siteUrl: SITE,
        localizations: built,
      },
      null,
      2
    ),
    "utf8"
  );

  const appid = built.filter((l) => l.steamAppId).length;
  console.log(
    `[ctrltrad] done → ${built.length} entries | appid=${appid} (${Math.round((100 * appid) / (built.length || 1))}%)`
  );

  // Dump non-perfect resolutions to a file for manual review — these are the
  // candidates for a future lib/steam-overrides.json.
  await writeFile(
    join(ROOT, "data", "ctrltrad.candidates.json"),
    JSON.stringify(candidates, null, 2),
    "utf8"
  );
  const nulls = candidates.filter((c) => !c.appId).length;
  const low = candidates.filter((c) => c.appId && c.score < 100).length;
  console.log(
    `[ctrltrad] candidates → nulls=${nulls}, sub-100=${low} (written to data/ctrltrad.candidates.json)`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
