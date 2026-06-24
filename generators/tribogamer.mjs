/**
 * Generator: Tribo Gamer -> data/tribogamer.json
 *
 * Brazilian-Portuguese (pt-BR) localization aggregator. Game pages are static
 * HTML with a clean form-group metadata table:
 *   <div class="control-label"><b>LABEL</b></div><div class="col-xs-9">VALUE</div>
 * giving Versão / Idioma / Versão Suportada / Idioma Suportado / Lançamento /
 * Tamanho, plus a Créditos block (Administrador / Tradutores / Revisores / …)
 * and an Observações note. The bare game name sits in the sidebar:
 *   <div class="jogo-perfil-detalhes"><h5>GAME</h5>.
 *
 * Download: the card's "DOWNLOAD" points to <page>/download.html, which embeds a
 * `…/direct/?…&duf=<reverse-base64>` link. Decoding `duf` (reverse the string,
 * then base64) yields a REAL direct file URL on s1.ttriber.com (Content-Type
 * application/x-msdownload) — a rare aggregator with a true in-app direct
 * download. The same query also carries filename/size/date/version as a fallback.
 *
 * Category: aggregator -> Créditos go into authorsHtml. Modal CONTENT (the
 * Observações install note) stays Portuguese — the source language. Steam app id
 * via exact title match on the sidebar game name.
 */
import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  UA,
  sleep,
  fetchTimeout,
  mapPool,
  getTextCurl as getText,
  decodeReversedB64,
} from "../lib/net.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const SITE = "https://tribogamer.com";

const STUDIO = "Tribo Gamer";
const LANGUAGE = "Português (Brasil)";

// Créditos roles we surface, in the source language (kept Portuguese on purpose).
const CREDIT_ROLES = [
  "Administrador",
  "Co-Administrador(es)",
  "Tradutores",
  "Revisores",
  "Edição de Imagens",
  "Tests-ingame",
  "Instalador",
  "Ferramentas",
];

const decodeEntities = (s) =>
  (s || "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"');

/* ----------------------------- catalogue index ---------------------------- */

/** Walk /traducoes/ then /traducoes/page-N.html until a page yields nothing new. */
async function fetchCatalogue() {
  const urls = new Map();
  const maxPages = Number(process.env.TRIBO_MAX_PAGES) || 200;
  let fails = 0;
  for (let page = 1; page <= maxPages; page += 1) {
    const pageUrl = page === 1 ? `${SITE}/traducoes/` : `${SITE}/traducoes/page-${page}.html`;
    let html;
    try {
      html = await getText(pageUrl);
      fails = 0;
    } catch (err) {
      console.warn(`\n  ! catalogue page ${page}: ${err.message}`);
      fails += 1;
      if (fails >= 4) break;
      await sleep(3000);
      continue;
    }
    const before = urls.size;
    // Game links: /traducoes/<id>_<slug>.html (the trailing ".html" rules out the
    // /traducoes/<id>_<slug>/download.html links on the same page).
    for (const m of html.matchAll(/\/traducoes\/(\d+)_([a-z0-9-]+)\.html/gi)) {
      urls.set(m[1], `${SITE}/traducoes/${m[1]}_${m[2]}.html`);
    }
    process.stdout.write(`\r[tribo] catalogue page ${page}, ${urls.size} games     `);
    if (urls.size === before) break; // past the last page (no new games)
    await sleep(60);
  }
  console.log("");
  return [...urls.values()];
}

/* ------------------------------- file page -------------------------------- */

/** All <b>LABEL</b> … <div class="col-xs-9">VALUE</div> pairs on a game page. */
function parseFields(html) {
  const fields = new Map();
  const re =
    /control-label"><b>([^<]+)<\/b><\/div>\s*<div class="col-xs-9">([\s\S]*?)<\/div>/g;
  let m;
  while ((m = re.exec(html))) {
    const value = decodeEntities(m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")).trim();
    fields.set(decodeEntities(m[1]).trim(), value);
  }
  return fields;
}

/** Date "20/05/2023" stays as-is (DD/MM/YYYY) — the site's own format. */
const cleanCredit = (v) => (v || "").replace(/[,\s]+$/, "").trim();

/** Builds the authorsHtml from the Créditos rows (Portuguese labels kept). */
function buildAuthors(fields) {
  const rows = [];
  for (const role of CREDIT_ROLES) {
    const name = cleanCredit(fields.get(role));
    if (!name || /^n\/a$/i.test(name)) continue;
    rows.push(`<p><strong>${role}:</strong> ${name}</p>`);
  }
  return rows.length ? rows.join("") : null;
}

/** The Observações note (Portuguese), as HTML, with Cloudflare junk stripped. */
function extractObservacoes(html) {
  const i = html.search(/Observações<\/[^>]+>/i);
  if (i < 0) return null;
  const after = html.slice(i);
  // Content lives in the box-content right after the Observações divider; stop at
  // the next box section / sidebar.
  const m = after.match(/box-content"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/i);
  if (!m) return null;
  let body = m[1]
    .replace(/\son[a-z]+="[^"]*"/gi, "") // strip onclick=… handlers
    .replace(/\sdata-cf-[a-z-]+="[^"]*"/gi, "") // strip Cloudflare data-cf-*
    .replace(/\s+/g, " ")
    .trim();
  return body ? `<div>${body}</div>` : null;
}

function buildEntry(pageUrl, html, download) {
  const fields = parseFields(html);

  // Bare game name from the sidebar profile header (cleanest for Steam matching).
  const title =
    decodeEntities((html.match(/jogo-perfil-detalhes"><h5>([^<]+)<\/h5>/i) || [])[1] || "").trim() ||
    decodeEntities((html.match(/<title>\s*Tradução d[oae]?\s+(.+?)\s+para\s+Português/i) || [])[1] || "").trim();
  if (!title) return null;

  const version = fields.get("Versão") || download?.version || null;
  const size = fields.get("Tamanho") || download?.size || null;
  const updatedAt = fields.get("Lançamento") || download?.date || null;

  // These are subtitle/text translations; flag voice only if the page says so.
  const blob = `${title} ${extractObservacoes(html) || ""}`.toLowerCase();
  const hasVoice = /dublagem|dublad[oa]|\bvoz(?:es)?\b|áudio|dublag/.test(blob);

  const mirrors = download?.url
    ? [{ label: STUDIO, url: download.url, kind: "direct" }]
    : [{ label: STUDIO, url: pageUrl, kind: "other" }];

  return {
    title,
    studio: STUDIO,
    studioUrl: pageUrl,
    language: LANGUAGE,
    hasText: true,
    hasVoice,
    hasTextures: false,
    hasNeuralVoice: false,
    hasNeuralDub: false,
    hasNeuralText: false,
    version,
    updatedAt,
    pageUrl,
    howToInstallHtml: extractObservacoes(html),
    changelogHtml: null,
    // Aggregator: the translating team (Créditos) is the author.
    authorsHtml: buildAuthors(fields),
    size,
    inDevelopment: false,
    mirrors,
  };
}

/** Resolves the real direct file URL from <page>/download.html (decodes `duf`). */
async function resolveDownload(pageUrl) {
  try {
    const dlPage = pageUrl.replace(/\.html$/, "/download.html");
    const html = await getText(dlPage);
    const link = (html.match(/href="(https?:\/\/[^"]*\/direct\/\?[^"]*duf=[^"]*)"/i) || [])[1];
    if (!link) return null;
    const q = Object.fromEntries(new URL(link.replace(/&amp;/g, "&")).searchParams);
    const url = decodeReversedB64(q.duf);
    if (!url || !/^https?:\/\//.test(url)) return null;
    return {
      url,
      size: q.filesizef ? decodeReversedB64(q.filesizef) : null,
      date: q.filedatef ? decodeReversedB64(q.filedatef) : null,
      version: q.fileversionf ? decodeReversedB64(q.fileversionf) : null,
    };
  } catch {
    return null;
  }
}

/* --------------------------- steam app id lookup -------------------------- */

const STEAM_SEARCH = "https://store.steampowered.com/api/storesearch/";
const normalizeTitle = (t) =>
  (t || "").toLowerCase().replace(/['’:.,!?®™&–—_-]/g, " ").replace(/\s+/g, " ").trim();
const stripSuffix = (t) => {
  let prev,
    out = t.trim();
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
  console.log("[tribo] fetching catalogue…");
  const urls = await fetchCatalogue();
  console.log(`[tribo] ${urls.length} translations`);

  let done = 0;
  const built = (
    await mapPool(urls, 4, async (pageUrl) => {
      let entry = null;
      try {
        const html = await getText(pageUrl);
        const download = await resolveDownload(pageUrl);
        entry = buildEntry(pageUrl, html, download);
      } catch (err) {
        console.warn(`\n  ! ${pageUrl}: ${err.message}`);
      }
      done += 1;
      if (done % 25 === 0 || done === urls.length)
        process.stdout.write(`\r[tribo] page ${done}/${urls.length}     `);
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
      process.stdout.write(`\r[tribo] appid ${j}/${built.length}     `);
  });
  console.log("");

  await mkdir(join(ROOT, "data"), { recursive: true });
  await writeFile(
    join(ROOT, "data", "tribogamer.json"),
    JSON.stringify(
      { name: STUDIO, language: LANGUAGE, category: "aggregator", siteUrl: SITE, localizations: built },
      null,
      2
    ),
    "utf8"
  );

  const appid = built.filter((l) => l.steamAppId).length;
  const direct = built.filter((l) => l.mirrors.some((m) => m.kind === "direct")).length;
  const withAuthors = built.filter((l) => l.authorsHtml).length;
  console.log(
    `[tribo] done → ${built.length} (appid=${appid}, direct=${direct}, authors=${withAuthors})`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
