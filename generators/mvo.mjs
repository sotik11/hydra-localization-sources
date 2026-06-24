/**
 * Generator: Mechanics VoiceOver (rgmvo.ru) -> data/mvo.json
 *
 * MVO exposes a Laravel catalogue API (paginated) but the actual download
 * mirrors live on each game's page (Nuxt-rendered). So we:
 *   1. page through /api/games/all  -> game list (alias, title, flags)
 *   2. fetch each /game/<alias>/     -> scrape the cloud-mirror links
 *   3. emit our LocalizationFile JSON (no `direct` mirror; cloud links only)
 *
 * MVO is a voiceover studio, so hasVoice is assumed true. Matching is by title
 * (the site doesn't expose a Steam app id). `is_in_progress` -> inDevelopment.
 */
import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as cheerio from "cheerio";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const API = "https://api.rgmvo.ru/api";
const SITE = "https://rgmvo.ru";
const UA = "hydra-localization-sources/0.1 (localization mirror indexer)";

const STUDIO = "Mechanics VoiceOver";
const STUDIO_URL = "https://rgmvo.ru";
const LANGUAGE = "Русский";

// MVO ships the same installer/uninstaller flow for every game.
const HOW_TO_INSTALL =
  `<p><strong>Установка:</strong></p>` +
  `<p>Следуйте инструкциям инсталлятора. Установка полностью автоматическая.</p>` +
  `<br>` +
  `<p><strong>Удаление:</strong></p>` +
  `<p>Зайдите в директорию Install_Rus_Snd и запустите файл unins***.exe.</p>`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": UA },
  });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json();
}

async function getText(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.text();
}

/** Pages through /api/games/all, deduped by alias (guards pagination quirks). */
async function fetchAllGames() {
  const byAlias = new Map();
  let page = 1;
  let lastPage = 1;

  do {
    const json = await getJson(`${API}/games/all?page=${page}`);
    const data = json?.data ?? {};
    for (const item of data.items ?? []) {
      if (item?.alias) byAlias.set(item.alias, item);
    }
    lastPage = data?.pagination?.last_page ?? page;
    page += 1;
    if (page <= lastPage) await sleep(150);
  } while (page <= lastPage);

  return [...byAlias.values()];
}

const MIRROR_RULES = [
  { kind: "yandex", label: "Яндекс.Диск", re: /https?:\/\/disk\.yandex\.[a-z]{2,3}\/[^\s"'\\<>]+/gi },
  { kind: "google", label: "Google Drive", re: /https?:\/\/drive\.google\.com\/[^\s"'\\<>]+/gi },
  { kind: "other", label: "MediaFire", re: /https?:\/\/(?:www\.)?mediafire\.com\/[^\s"'\\<>]+/gi },
  { kind: "mail", label: "Облако Mail.ru", re: /https?:\/\/cloud\.mail\.ru\/[^\s"'\\<>]+/gi },
];

/** Pulls the cloud-mirror download links out of a game's page HTML. */
function extractMirrors(html) {
  const out = [];
  const seen = new Set();
  for (const { kind, label, re } of MIRROR_RULES) {
    for (const raw of html.match(re) ?? []) {
      const url = raw.replace(/[\\"'),.]+$/, "");
      if (seen.has(url)) continue;
      seen.add(url);
      out.push({ label, url, kind });
    }
  }
  return out;
}

const STEAM_SEARCH = "https://store.steampowered.com/api/storesearch/";

function normalizeTitle(t) {
  return (t || "")
    .toLowerCase()
    .replace(/['’:.,!?®™&–—_-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Drops a trailing "(Remake)" / "(2016)" / edition note for a 2nd attempt. */
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

/**
 * Resolves a Steam app id by exact (normalized) title match — tries the raw
 * title, then a suffix-stripped variant ("Silent Hill 2 (Remake)" -> "...2").
 * Returns null when unsure, so we never attach a wrong app id.
 */
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

/**
 * Reads the game page's <dt>label</dt><dd>value</dd> spec rows:
 *   "Вид русификации"      -> hasVoice / hasText
 *   "Версия русификатора"  -> version + updatedAt ("1.14 от 06.08.2024")
 *   "Требуемая версия игры" -> requiredGameVersion
 * (Changelog / install tabs are client-rendered, so not available here.)
 */
function parseDetail(html) {
  const $ = cheerio.load(html);
  const specs = {};
  $("dt").each((_, el) => {
    const label = $(el).text().trim().replace(/:\s*$/, "");
    const value = $(el).next("dd").text().trim();
    if (label && value) specs[label] = value;
  });

  const detail = {};

  const kind = specs["Вид русификации"];
  if (kind) {
    detail.hasVoice = /звук|озвуч/i.test(kind);
    detail.hasText = /текст/i.test(kind);
  }

  const ver = specs["Версия русификатора"];
  if (ver) {
    const m = ver.match(/^(.*?)\s+от\s+(\d{1,2}\.\d{2}\.\d{4})/);
    detail.version = (m ? m[1] : ver).trim();
    detail.updatedAt = m ? m[2] : null;
  }

  const required = specs["Требуемая версия игры"];
  if (required) {
    // No version number ("Любая [Steam]") -> "any version": drop the store tags
    // so it reads cleanly ("Любая"). With digits we keep the per-store builds.
    detail.requiredGameVersion = /\d/.test(required)
      ? required
      : required.replace(/\s*\[[^\]]*\]/g, "").trim() || required.trim();
  }

  return detail;
}

async function buildEntry(game) {
  const pageUrl = `${SITE}/game/${game.alias}/`;
  let mirrors = [];
  let detail = {};
  try {
    const html = await getText(pageUrl);
    mirrors = extractMirrors(html);
    detail = parseDetail(html);
  } catch (err) {
    console.warn(`\n  ! detail failed for ${game.alias}: ${err.message}`);
  }
  const steamAppId = await resolveSteamAppId(game.title);
  return {
    steamAppId: steamAppId ?? undefined,
    title: game.title,
    studio: STUDIO,
    studioUrl: STUDIO_URL,
    language: LANGUAGE,
    hasVoice: detail.hasVoice ?? true,
    hasText: detail.hasText ?? false,
    version: detail.version ?? null,
    updatedAt: detail.updatedAt ?? null,
    requiredGameVersion: detail.requiredGameVersion ?? null,
    howToInstallHtml: HOW_TO_INSTALL,
    pageUrl,
    inDevelopment: game.is_in_progress === true || game.is_in_progress === 1,
    mirrors,
  };
}

async function main() {
  console.log("[MVO] fetching catalogue…");
  const games = (await fetchAllGames()).filter((g) => g.is_active);
  console.log(`[MVO] ${games.length} active games`);

  const localizations = [];
  let i = 0;
  for (const game of games) {
    i += 1;
    const entry = await buildEntry(game);
    localizations.push(entry);
    process.stdout.write(
      `\r[MVO] detail ${i}/${games.length} — ${entry.title.slice(0, 30)} (${entry.mirrors.length} mirrors)        `
    );
    await sleep(120);
  }
  console.log("");

  const file = { name: STUDIO, language: LANGUAGE, category: "studio", siteUrl: SITE, localizations };
  await mkdir(join(ROOT, "data"), { recursive: true });
  const outPath = join(ROOT, "data", "mvo.json");
  await writeFile(outPath, JSON.stringify(file, null, 2), "utf8");

  const withMirrors = localizations.filter((l) => l.mirrors.length > 0).length;
  const inDev = localizations.filter((l) => l.inDevelopment).length;
  const withVersion = localizations.filter((l) => l.version).length;
  const withReq = localizations.filter((l) => l.requiredGameVersion).length;
  const withAppId = localizations.filter((l) => l.steamAppId).length;
  console.log(`[MVO] done → ${outPath}`);
  console.log(
    `[MVO] total=${localizations.length}, mirrors=${withMirrors}, in-dev=${inDev}, version=${withVersion}, req-version=${withReq}, steam-appid=${withAppId}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
