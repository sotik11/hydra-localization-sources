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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const API = "https://api.rgmvo.ru/api";
const SITE = "https://rgmvo.ru";
const UA = "hydra-localization-sources/0.1 (localization mirror indexer)";

const STUDIO = "Mechanics VoiceOver";
const STUDIO_URL = "https://rgmvo.ru";
const LANGUAGE = "Русский";

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

async function buildEntry(game) {
  const pageUrl = `${SITE}/game/${game.alias}/`;
  let mirrors = [];
  try {
    mirrors = extractMirrors(await getText(pageUrl));
  } catch (err) {
    console.warn(`\n  ! detail failed for ${game.alias}: ${err.message}`);
  }
  return {
    title: game.title,
    studio: STUDIO,
    studioUrl: STUDIO_URL,
    language: LANGUAGE,
    hasVoice: true,
    hasText: false,
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

  const file = { name: STUDIO, localizations };
  await mkdir(join(ROOT, "data"), { recursive: true });
  const outPath = join(ROOT, "data", "mvo.json");
  await writeFile(outPath, JSON.stringify(file, null, 2), "utf8");

  const withMirrors = localizations.filter((l) => l.mirrors.length > 0).length;
  const inDev = localizations.filter((l) => l.inDevelopment).length;
  console.log(`[MVO] done → ${outPath}`);
  console.log(
    `[MVO] total=${localizations.length}, with mirrors=${withMirrors}, in-development=${inDev}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
