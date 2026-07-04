/**
 * Generator: TraductionJeux (traductionjeux.com) -> data/traductionjeux.json
 *
 * A long-standing French PC fan-translation portal — ~1000 games, one page per
 * game listing multi-hoster download mirrors. Pages are old-school PageBreeze
 * WYSIWYG HTML (every text/image sits in <div style="position:absolute; left/top">),
 * so we don't rely on document flow — we align labels and values by their `top`
 * coordinate (±3px tolerance).
 *
 * Catalogue: 27 alphabetical index pages (patchsfr-{a..z}.html + patchsfr-09.html),
 * each listing links to per-game pages. We keep only PC entries (Plate-forme = PC).
 *
 * Mirrors: file-hosters are all browser-only (turbobit, ul.to (Uploaded),
 * 1fichier, uptobox, mega.nz, depositfiles, istockfile). None are login-walled —
 * they use free wait-timers and session cookies, so a browser flow works. We keep
 * every external link as kind: "other" (Hydra opens them in the browser).
 *
 * Multi-part: large games are split across hosters — e.g. Witcher 3 has 4 parts
 * per hoster on 5 hosters. Group links by host and emit them as a single mirror
 * with `parts: [url1, url2, …]` when there are 2+ URLs on the same host.
 *
 * TXT redirects: a few pages (Watch Dogs 2, …) redirect through a same-domain
 * `.txt` file that just lists cloud URLs — fetch it and treat the contents as
 * additional mirror candidates.
 *
 * Steam appId: page titles are clean ("Alan Wake", "The Witcher 3 GOTY", …) so a
 * normalized Steam storesearch match works well.
 *
 * Fetch mixture: getText (undici, tries=4 + backoff), mapPool=4, fetchTimeout.
 * (Cloudflare-ish 522/526 happens occasionally on the origin — the guard in
 * regen_all.sh restores the previous data if a run collapses.)
 */
import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as cheerio from "cheerio";
import { UA, sleep, fetchTimeout, mapPool, getText, normalizeSize } from "../lib/net.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const SITE = "https://traductionjeux.com";
const STUDIO = "TraductionJeux";
const LANGUAGE = "Français";

// PageBreeze image hashes we can identify: green tick vs red cross for the
// Textes / Voix / Cinématiques FR rows.
const IMG_CHECK = "wp8b324d23_1a.png";
const IMG_CROSS = "wpb9dc00ea_1a.png";

// Catalogue letters: a..z + "09" (numbers + non-letter titles).
const LETTERS = "0abcdefghijklmnopqrstuvwxyz".split("");
const catalogueUrl = (letter) =>
  letter === "0"
    ? `${SITE}/patchsfr-09.html`
    : `${SITE}/patchsfr-${letter}.html`;

// External hosters we ACCEPT as mirrors (labels used in the modal row).
const HOSTERS = [
  { host: "turbobit", label: "Turbobit" },
  { host: "ul.to", label: "Uploaded" },
  { host: "uploaded", label: "Uploaded" },
  { host: "1fichier", label: "1fichier" },
  { host: "uptobox", label: "Uptobox" },
  { host: "mega.nz", label: "MEGA" },
  { host: "mega.co.nz", label: "MEGA" },
  { host: "depositfiles", label: "DepositFiles" },
  { host: "istockfile", label: "iStockFile" },
  { host: "mediafire", label: "MediaFire" },
  { host: "usersdrive", label: "UsersDrive" },
  { host: "rapidgator", label: "Rapidgator" },
  { host: "4shared", label: "4shared" },
];

// URL-fragments that are NEVER a mirror (ad networks / shorteners / same-site).
const SKIP_URL = [
  "ow.ly",
  "bit.ly",
  "tinyurl",
  "goo.gl",
  "twitter.com",
  "facebook.com",
  "youtube.com",
  "youtu.be",
  "google-analytics",
  "statcounter",
  "schema.org",
  "w3.org",
  "traductionjeux.com/desactiver-adblock",
  "traductionjeux.com/comment",
  "traductionjeux.com/faq",
  "traductionjeux.com/contact",
  "traductionjeux.com/signaler",
];

const HOW_TO_INSTALL = [
  `<p>Chaque patch a sa propre procédure d'installation — ouvre la page du jeu `,
  `(bouton « Ouvrir dans le navigateur » ci-dessous) et suis les étapes qui y `,
  `sont indiquées. Les téléchargements passent par des hébergeurs de fichiers `,
  `(Turbobit, 1fichier, Uploaded, Uptobox, MEGA…) qui appliquent une petite `,
  `attente en mode gratuit — c'est normal, pas besoin de compte.</p>`,
].join("");

/* ----------------------------- catalogue index ---------------------------- */

async function fetchCatalogue() {
  const slugs = new Set();
  for (const letter of LETTERS) {
    let html;
    try {
      html = await getText(catalogueUrl(letter));
    } catch (err) {
      console.warn(`\n  ! catalogue ${letter}: ${err.message}`);
      continue;
    }
    // per-game pages are relative *.html links (excluding the alphabetical
    // catalogue pages themselves and site-nav links).
    const $ = cheerio.load(html);
    $("a[href$='.html']").each((_, el) => {
      const href = ($(el).attr("href") || "").trim();
      if (!href || /^https?:/i.test(href)) return;
      if (/^(patchsfr|manuelsfr|index|desactiver|comment-|contact|faq|signaler|saves|savegame)/i.test(href)) return;
      slugs.add(href);
    });
    process.stdout.write(`\r[traductionjeux] letter ${letter}, ${slugs.size} pages    `);
    await sleep(120);
  }
  console.log("");
  return [...slugs];
}

/* ------------------------- coordinate-based parsing ----------------------- */

/** Parse `left` and `top` px numbers from an inline style attribute. */
function xy(style) {
  const l = style?.match(/left:\s*(-?\d+)px/);
  const t = style?.match(/top:\s*(-?\d+)px/);
  return {
    left: l ? Number(l[1]) : NaN,
    top: t ? Number(t[1]) : NaN,
  };
}

/** Clean a slug into a readable title as a last-resort. */
function slugToTitle(slug) {
  return decodeURIComponent(slug)
    .replace(/\.html$/i, "")
    .replace(/[-_]+/g, " ")
    // strip "patch fr", "traduction fr", "pfr", "pc" suffixes commonly baked
    // into filenames (case-insensitive, whitespace-tolerant).
    .replace(/\s+(patch|traduction)(\s+fr)?(\s+pc)?\s*$/i, "")
    .replace(/\s+pfr\s*$/i, "")
    .replace(/\s+pc\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Prefer a title from the page: an <h1>/<h2>, else the game-title block that
 *  sits between the cover art and the field table (top ~1100-1180 in the
 *  PageBreeze layout — a single text block with the game's own name in it). */
function pickTitle($, blocks) {
  const h1 = $("h1, h2").first().text().replace(/\s+/g, " ").trim();
  if (h1 && h1.length > 2 && h1.length < 120) return h1;
  // Scan blocks top-first — the game title lives above the field table (top
  // ~1130 in the PageBreeze layout), so it precedes the "Type :" label (~1179).
  // Skip anything that looks like a label, a field value, or a download table
  // (some pages put a mirror listing — "ME: Part1 Part2 OU UL: …" — in that
  // same top range, which would otherwise be picked as the title).
  const SKIP =
    /(^|\s)(Type|Plate-forme|Taille|Textes FR|Voix FR|Cin[eé]matiques FR|Version du Patch|Patch FR|Traduction|Comment|Derniers|Top Patchs|©|Part\s*\d|ME:|UL:|OB:|1F:|TB:|UB:)/i;
  const sorted = blocks.slice().sort((a, b) => a.top - b.top);
  const above = sorted.find(
    (b) =>
      b.top >= 1090 &&
      b.top <= 1170 &&
      b.text.length >= 3 &&
      b.text.length <= 120 &&
      !SKIP.test(b.text) &&
      !/^(PC|OU|v ?\d)/i.test(b.text)
  );
  return above?.text || null;
}

/**
 * Read the labelled fields (Type / Plate-forme / Taille / Textes FR / Voix FR /
 * Cinématiques FR / Version du Patch FR) by aligning label-divs with value-divs
 * (or value-imgs, for the yes/no tick) by their `top` coordinate.
 */
function extractFields($) {
  const texts = [];
  // Both txt_ (plain text) and art_ (styled text — e.g. "1.67 Go" for Taille,
  // sometimes the game title too) carry values we need to align by top-line.
  $("div[id^=txt_], div[id^=art_]").each((_, el) => {
    const $el = $(el);
    const { left, top } = xy($el.attr("style") || "");
    if (!Number.isFinite(top)) return;
    texts.push({ left, top, text: $el.text().replace(/\s+/g, " ").trim() });
  });

  const imgs = [];
  $("img[src^='wpimages/']").each((_, el) => {
    const $el = $(el);
    const { left, top } = xy($el.attr("style") || "");
    if (!Number.isFinite(top)) return;
    imgs.push({ left, top, src: ($el.attr("src") || "").split("/").pop() });
  });

  // Text-valued fields (label ↔ text block on the same top-line).
  const TEXT_LABELS = {
    type: /^Type\s*:/,
    plateforme: /^Plate-forme\s*:/,
    taille: /^Taille\s*:/,
    version: /^Version du Patch FR\s*:/,
  };
  // Boolean-valued fields (label ↔ tick/cross <img> on the same top-line).
  // Read only from images — the "OU" separator between download buttons often
  // shares this top-line and would otherwise steal the value.
  const IMG_LABELS = {
    textes: /^Textes FR\s*:/,
    voix: /^Voix FR\s*:/,
    cinematiques: /^Cin[eé]matiques FR\s*:/,
  };

  const anyLabel = [
    ...Object.values(TEXT_LABELS),
    ...Object.values(IMG_LABELS),
  ];

  const fields = {};
  for (const [key, re] of Object.entries(TEXT_LABELS)) {
    const label = texts.find((t) => re.test(t.text));
    if (!label) continue;
    const value = texts.find(
      (t) =>
        Math.abs(t.top - label.top) <= 3 &&
        t.left > label.left + 50 &&
        // stay near the field-value column (~411px); don't wander to the far
        // right (~637px) where the "OU" divider and download buttons live.
        t.left < label.left + 300 &&
        t.text &&
        !anyLabel.some((r) => r.test(t.text))
    );
    if (value) fields[key] = { kind: "text", value: value.text };
  }
  for (const [key, re] of Object.entries(IMG_LABELS)) {
    const label = texts.find((t) => re.test(t.text));
    if (!label) continue;
    const valueImg = imgs.find(
      (i) =>
        Math.abs(i.top - label.top) <= 3 &&
        i.left > label.left + 50 &&
        i.left < label.left + 300
    );
    if (valueImg) fields[key] = { kind: "img", src: valueImg.src };
  }
  return { fields, blocks: texts };
}

const tickToBool = (field) => {
  if (!field || field.kind !== "img") return false;
  if (field.src === IMG_CHECK) return true;
  if (field.src === IMG_CROSS) return false;
  return false;
};

/* --------------------------- mirror extraction ---------------------------- */

function classifyLink(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const host = url.host.replace(/^www\./, "").toLowerCase();
    for (const skip of SKIP_URL) {
      if (rawUrl.includes(skip)) return null;
    }
    const hoster = HOSTERS.find((h) => host.includes(h.host));
    if (!hoster) return null;
    return { host: hoster.host, label: hoster.label, url: rawUrl };
  } catch {
    return null;
  }
}

/**
 * Some pages redirect to a same-origin *.txt file that just lists cloud URLs.
 * If we spot such a link, fetch the txt and treat its contents as extra mirror
 * candidates. Returns a list of raw URL strings (empty on any error).
 */
async function followTxtRedirects($, seenUrls) {
  const txtLinks = new Set();
  const collectTxt = (raw) => {
    const href = (raw || "").trim();
    if (!href || href.startsWith("#") || !href.toLowerCase().endsWith(".txt")) return;
    // Only follow same-origin *.txt (avoid random external things).
    if (/^https?:/i.test(href) && !href.includes("traductionjeux.com")) return;
    txtLinks.add(href.startsWith("http") ? href : `${SITE}/${href}`);
  };
  // Older pages put the txt-redirect link inside an <area> of an image-map,
  // newer pages use a plain <a>. Cover both.
  $("a[href]").each((_, el) => collectTxt($(el).attr("href")));
  $("area[href]").each((_, el) => collectTxt($(el).attr("href")));
  const found = [];
  for (const txt of txtLinks) {
    if (seenUrls.has(txt)) continue;
    seenUrls.add(txt);
    try {
      const body = await getText(txt);
      for (const m of body.matchAll(/https?:\/\/[^\s"'<>]+/g)) {
        found.push(m[0].trim().replace(/[.,)]+$/, ""));
      }
    } catch (err) {
      console.warn(`\n  ! txt ${txt}: ${err.message}`);
    }
  }
  return found;
}

function groupMirrors(candidates) {
  // Preserve first-seen order per host so multi-part indices stay stable.
  const byHost = new Map();
  for (const c of candidates) {
    if (!byHost.has(c.host)) byHost.set(c.host, { label: c.label, urls: [] });
    if (!byHost.get(c.host).urls.includes(c.url)) {
      byHost.get(c.host).urls.push(c.url);
    }
  }
  const mirrors = [];
  for (const { label, urls } of byHost.values()) {
    if (urls.length === 1) {
      mirrors.push({ label, url: urls[0], kind: "other" });
    } else {
      mirrors.push({ label, url: urls[0], kind: "other", parts: urls });
    }
  }
  return mirrors;
}

/* ------------------------------- game page -------------------------------- */

async function buildEntry(slug) {
  const pageUrl = `${SITE}/${slug}`;
  const html = await getText(pageUrl);
  const $ = cheerio.load(html);

  const { fields, blocks } = extractFields($);

  // Skip non-PC entries (traductionjeux hosts patches for older consoles too).
  const platform = fields.plateforme?.value || "";
  if (!/PC|Windows/i.test(platform)) return null;

  // Game title: prefer an on-page header (a title text block above the field
  // table) and fall back to a cleaned slug when the page lacks it.
  const title = pickTitle($, blocks) || slugToTitle(slug);

  // Collect mirror candidates: every <a href> AND every <area href> (a lot of
  // older pages wrap the download buttons in image-maps, so the link sits on
  // <area> not <a>).
  const seenUrls = new Set();
  const candidates = [];
  const pushHref = (raw) => {
    const href = (raw || "").trim();
    if (!href || seenUrls.has(href)) return;
    seenUrls.add(href);
    const c = classifyLink(href);
    if (c) candidates.push(c);
  };
  $("a[href]").each((_, el) => pushHref($(el).attr("href")));
  $("area[href]").each((_, el) => pushHref($(el).attr("href")));

  // Follow TXT-redirect pages (Watch Dogs 2 style).
  const extraUrls = await followTxtRedirects($, seenUrls);
  for (const raw of extraUrls) {
    const c = classifyLink(raw);
    if (c) candidates.push(c);
  }

  if (!candidates.length) return null;

  const mirrors = groupMirrors(candidates);

  const version =
    fields.version?.value?.trim().replace(/^v\.?\s*/i, "") || null;
  const size = normalizeSize(fields.taille?.value || null);

  return {
    title,
    studio: STUDIO,
    studioUrl: pageUrl,
    language: LANGUAGE,
    hasText: tickToBool(fields.textes),
    hasVoice: tickToBool(fields.voix),
    hasTextures: false,
    hasSongs: false,
    hasNeuralVoice: false,
    hasNeuralDub: false,
    hasNeuralText: false,
    // "Cinématiques FR" — the site's own extra flag; we surface it via voice
    // when the video sub-tracks are dubbed too. Keep hasSongs off (unrelated).
    // Left as-is; users see the flag in the source language on the page.
    version,
    updatedAt: null,
    requiredGameVersion: null,
    pageUrl,
    howToInstallHtml: HOW_TO_INSTALL,
    authorsHtml: null,
    size,
    inDevelopment: false,
    archivePassword: null,
    mirrors,
  };
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
  const variants = [...new Set([title, stripSuffix(title)])];
  const targets = new Set(variants.map(normalizeTitle));
  for (const term of variants) {
    try {
      const res = await fetchTimeout(
        `${STEAM_SEARCH}?term=${encodeURIComponent(term)}&cc=us&l=en`,
        { headers: { Accept: "application/json", "User-Agent": UA } }
      );
      const json = await res.json();
      const hit = (json?.items || []).find((it) =>
        targets.has(normalizeTitle(it.name))
      );
      if (hit?.id) return String(hit.id);
    } catch {
      /* timeout — miss, not stall */
    }
  }
  return null;
}

/* ---------------------------------- main ---------------------------------- */

async function main() {
  console.log("[traductionjeux] fetching catalogue…");
  const slugs = await fetchCatalogue();
  console.log(`[traductionjeux] ${slugs.length} pages in catalogue`);

  let done = 0;
  const built = (
    await mapPool(slugs, 4, async (slug) => {
      let entry = null;
      try {
        entry = await buildEntry(slug);
      } catch (err) {
        console.warn(`\n  ! ${slug}: ${err.message}`);
      }
      done += 1;
      if (done % 25 === 0 || done === slugs.length)
        process.stdout.write(`\r[traductionjeux] page ${done}/${slugs.length}     `);
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
  await mapPool(built, 4, async (e) => {
    const appid = await resolveCached(e.title);
    if (appid) e.steamAppId = appid;
    j += 1;
    if (j % 25 === 0 || j === built.length)
      process.stdout.write(`\r[traductionjeux] appid ${j}/${built.length}     `);
  });
  console.log("");

  await mkdir(join(ROOT, "data"), { recursive: true });
  await writeFile(
    join(ROOT, "data", "traductionjeux.json"),
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
  const multi = built.filter((l) => l.mirrors.some((m) => m.parts)).length;
  const withVoice = built.filter((l) => l.hasVoice).length;
  const withText = built.filter((l) => l.hasText).length;
  console.log(
    `[traductionjeux] done → ${built.length} entries (PC only) | appid=${appid}, multi-part=${multi}, text=${withText}, voice=${withVoice}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
