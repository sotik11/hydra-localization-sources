/**
 * Generator: Komunitní překlady (komunitni-preklady.org) -> data/komunitni-preklady.json
 *
 * Czech & Slovak community translation portal. Catalogue pages
 * /preklady/strana/N carry a JSON-LD ItemList (name, /preklad/<slug> url,
 * inLanguage cs|sk, author team, dates). Each translation page carries a JSON-LD
 * SoftwareApplication (softwareVersion, fileSize, dateModified, downloadUrl) plus
 * HTML for the game version and the translation type badge ("Ruční" vs AI).
 *
 * Download: /download/<id>?sig=... — the signature is REQUIRED (404 without it).
 * Taken as a direct in-app mirror (the sig is fresh each run); if it turns out to
 * be short-lived the UI falls back to "open in browser".
 *
 * Category: aggregator -> authorsHtml = the team. Modal content (install) stays
 * in the translation's own language (cs/sk); mirror labels are UI language.
 */
import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { UA, sleep, fetchTimeout, mapPool, getText, normalizeSize } from "../lib/net.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const SITE = "https://komunitni-preklady.org";

const STUDIO = "Komunitní překlady";
const LANG_NAME = { cs: "Čeština", sk: "Slovenčina" };

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

/* ----------------------------- catalogue index ---------------------------- */

/** All translation slugs, walking /preklady/strana/N. */
async function fetchCatalogue() {
  const slugs = new Set();
  let zeros = 0;
  for (let page = 1; page <= 80; page += 1) {
    let html;
    try {
      html = await getText(`${SITE}/preklady/strana/${page}`);
    } catch {
      break;
    }
    const before = slugs.size;
    for (const m of html.matchAll(/\/preklad\/([a-z0-9-]+)/gi)) slugs.add(m[1]);
    process.stdout.write(`\r[komunitni-preklady] strana ${page}, ${slugs.size} games     `);
    // strana 2-3 repeat page 1 (sidebar) before new content resumes, so don't
    // stop on the first empty page — only after several empties in a row.
    if (slugs.size === before) {
      zeros += 1;
      if (zeros >= 6) break;
    } else {
      zeros = 0;
    }
    await sleep(80);
  }
  console.log("");
  return slugs;
}

/* ------------------------------- file page -------------------------------- */

function buildEntry(slug, html) {
  const url = `${SITE}/preklad/${slug}`;

  const ld = (re) => (html.match(re) || [])[1] || null;
  const version = ld(/"softwareVersion":"([^"]+)"/);
  const size = normalizeSize(ld(/"fileSize":"([^"]+)"/));
  const updatedAt = isoToDate(ld(/"dateModified":"([^"]+)"/));
  const downloadUrl = ld(/"downloadUrl":"([^"]+)"/)?.replace(/\\u0026/gi, "&") || null;
  const name = ld(/"SoftwareApplication","name":"([^"]+)"/) || slug;
  const team = ld(/"author":\{"@type":"Organization","name":"([^"]+)"/);

  const gameVer =
    strip((html.match(/Verze\s+hry[\s\S]{0,80}?<\/[a-z]+>\s*<[^>]*>([^<]{1,40})/i) || [])[1] || "") ||
    ld(/"gameVersion":"([^"]+)"/) ||
    null;

  // Type from the page's method badge class: method-rucni (human) vs method-ai
  // (machine) / method-kombinace (machine + human correction) -> both neural.
  const neural = /method-(ai|kombinace)\b/.test(html);
  const lang = ld(/"inLanguage":"([a-z]{2})/) || "cs";

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
  console.log("[komunitni-preklady] fetching catalogue…");
  const slugs = [...(await fetchCatalogue())];
  console.log(`[komunitni-preklady] ${slugs.length} translations`);

  let done = 0;
  const built = (
    await mapPool(slugs, 4, async (slug) => {
      let entry = null;
      try {
        entry = buildEntry(slug, await getText(`${SITE}/preklad/${slug}`));
      } catch (err) {
        console.warn(`\n  ! ${slug}: ${err.message}`);
      }
      done += 1;
      if (done % 25 === 0 || done === slugs.length)
        process.stdout.write(`\r[komunitni-preklady] page ${done}/${slugs.length}     `);
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
      process.stdout.write(`\r[komunitni-preklady] appid ${j}/${built.length}     `);
  });
  console.log("");

  await mkdir(join(ROOT, "data"), { recursive: true });
  await writeFile(
    join(ROOT, "data", "komunitni-preklady.json"),
    JSON.stringify(
      { name: STUDIO, language: "Čeština", category: "aggregator", siteUrl: SITE, localizations: built },
      null,
      2
    ),
    "utf8"
  );

  const appid = built.filter((l) => l.steamAppId).length;
  const inDev = built.filter((l) => l.inDevelopment).length;
  const neural = built.filter((l) => l.hasNeuralText).length;
  const sk = built.filter((l) => l.language === "Slovenčina").length;
  console.log(
    `[komunitni-preklady] done → ${built.length} (appid=${appid}, in-dev=${inDev}, neural=${neural}, sk=${sk})`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
