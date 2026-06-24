/**
 * Generator: SynthVoiceRu -> data/synthvoiceru.json
 *
 * SynthVoiceRu is a studio making AI (neural) voice-overs/dubs. They sell on
 * Boosty (paid) and (almost) everything is mirrored free on PlayGround.
 *
 * This runs AFTER playground.mjs, which splits the {SynthVoiceRu} entries it
 * found during its scan into data/synthvoiceru.json. Here we:
 *   1. read those PlayGround entries (free download page + appid + neural flags),
 *   2. fetch the studio's project list from the Boosty API (auto-updating),
 *   3. add a Boosty link to every card (so a buyer can support the authors) and
 *      append Boosty projects that aren't on PlayGround yet (Boosty link only).
 *
 * Browser-only (like PlayGround). Matching is by title (Steam app id when known).
 */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { UA, sleep, fetchTimeout } from "../lib/net.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const STUDIO = "SynthVoiceRu";
const LANGUAGE = "Русский";
const BOOSTY = "https://boosty.to/synthvoiceru";
const SHOWCASE = `${BOOSTY}/showcase`;

const HOW_TO_INSTALL =
  `<p>Нейроозвучка от <strong>SynthVoiceRu</strong>. Бесплатная версия — на ` +
  `странице PlayGround («Открыть в браузере» ниже), там же инструкция по ` +
  `установке. Поддержать авторов и получить официальную версию можно на их ` +
  `<a href="${SHOWCASE}">Boosty</a>.</p>`;


const normTitle = (t) =>
  (t || "").toLowerCase().replace(/['’:.,!?®™&–—_-]/g, " ").replace(/\bii\b/g, "2").replace(/\s+/g, " ").trim();

/* ------------------------------- Boosty list ------------------------------ */

/** Pulls the game name out of a release-style post title. */
function gameFromPost(t) {
  let m;
  if ((m = t.match(/^(.+?)\s*[-–—:]\s*Русск(?:ая|ой)\s+[Оо]звучк/i))) return m[1];
  if ((m = t.match(/Русск(?:ая|ой)\s+[Оо]звучк[аи]?(?:\s+для)?[:\s]+(.+)$/i))) return m[1];
  if ((m = t.match(/Релиз\s+о[вз]зучки(?:\s+для|:)?\s+(.+)$/i))) return m[1];
  return null;
}

const cleanGame = (s) =>
  s.replace(/\([^)]*\)|\[[^\]]*\]/g, "").replace(/\s+/g, " ").trim();

/** Map normalized-game -> { game, url } from the Boosty posts API. */
async function fetchBoostyProjects() {
  const byGame = new Map();
  let offset = null;
  for (let guard = 0; guard < 30; guard += 1) {
    const url = `https://api.boosty.to/v1/blog/synthvoiceru/post/?limit=100${
      offset ? `&offset=${encodeURIComponent(offset)}` : ""
    }`;
    const res = await fetchTimeout(url, {
      headers: { "User-Agent": UA, Accept: "application/json", Referer: SHOWCASE },
    });
    if (!res.ok) break;
    const json = await res.json();
    for (const p of json.data || []) {
      const game = gameFromPost((p.title || "").replace(/\s+/g, " ").trim());
      if (!game) continue;
      const key = normTitle(cleanGame(game));
      if (!key || byGame.has(key)) continue; // newest post per game wins
      byGame.set(key, { game: cleanGame(game), url: `${BOOSTY}/posts/${p.id}` });
    }
    if (json.extra?.isLast || !(json.data || []).length) break;
    offset = json.extra?.offset;
    await sleep(120);
  }
  return byGame;
}

/* --------------------------- steam app id lookup -------------------------- */

async function resolveSteamAppId(title) {
  try {
    const json = await (
      await fetchTimeout(
        `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(title)}&cc=us&l=en`,
        { headers: { Accept: "application/json", "User-Agent": UA } }
      )
    ).json();
    const target = normTitle(title);
    const hit = (json?.items || []).find((it) => normTitle(it.name) === target);
    return hit?.id ? String(hit.id) : null;
  } catch {
    return null;
  }
}

/* ---------------------------------- main ---------------------------------- */

async function main() {
  const outPath = join(ROOT, "data", "synthvoiceru.json");

  let pgEntries = [];
  try {
    pgEntries = JSON.parse(await readFile(outPath, "utf8")).localizations || [];
  } catch {
    console.warn("[SVR] no synthvoiceru.json yet (run playground.mjs first)");
  }

  console.log("[SVR] fetching Boosty projects…");
  const boosty = await fetchBoostyProjects();
  console.log(`[SVR] ${pgEntries.length} on PlayGround, ${boosty.size} on Boosty`);

  // A studio's dub of one game may be split into several PlayGround files (parts
  // / versions). For a studio source we want ONE card per game, so collapse by
  // title and merge the content flags.
  const FLAGS = [
    "hasNeuralVoice",
    "hasNeuralDub",
    "hasNeuralText",
    "hasVoice",
    "hasText",
    "hasTextures",
  ];
  const pgByTitle = new Map();
  for (const e of pgEntries) {
    const key = normTitle(e.title);
    const existing = pgByTitle.get(key);
    if (existing) {
      for (const f of FLAGS) existing[f] = existing[f] || e[f];
      if (!existing.steamAppId && e.steamAppId) existing.steamAppId = e.steamAppId;
    } else {
      pgByTitle.set(key, { ...e });
    }
  }
  const pgGames = [...pgByTitle.values()];

  const seen = new Set();
  const out = [];

  // 1) PlayGround entries — keep free PG page (pageUrl) + add a Boosty link.
  for (const e of pgGames) {
    const key = normTitle(e.title);
    seen.add(key);
    const boostyUrl = boosty.get(key)?.url || SHOWCASE;
    out.push({
      ...e,
      studio: STUDIO,
      howToInstallHtml: HOW_TO_INSTALL,
      mirrors: [{ label: "Boosty (поддержать авторов)", url: boostyUrl, kind: "other" }],
    });
  }

  // 2) Boosty-only projects (not mirrored on PlayGround) — Boosty link only.
  let onlyBoosty = 0;
  for (const [key, b] of boosty) {
    if (seen.has(key)) continue;
    onlyBoosty += 1;
    const appid = await resolveSteamAppId(b.game);
    out.push({
      steamAppId: appid ?? undefined,
      title: b.game,
      studio: STUDIO,
      studioUrl: BOOSTY,
      language: LANGUAGE,
      hasText: false,
      hasVoice: false,
      hasTextures: false,
      hasNeuralVoice: true,
      hasNeuralDub: false,
      hasNeuralText: false,
      version: null,
      updatedAt: null,
      pageUrl: b.url,
      howToInstallHtml: HOW_TO_INSTALL,
      inDevelopment: false,
      mirrors: [],
    });
    await sleep(150);
  }

  const file = { name: STUDIO, language: LANGUAGE, category: "neural-studio", siteUrl: BOOSTY, localizations: out };
  await writeFile(outPath, JSON.stringify(file, null, 2), "utf8");
  const withAppId = out.filter((l) => l.steamAppId).length;
  console.log(
    `[SVR] done → ${out.length} total (PG=${pgGames.length}, boosty-only=${onlyBoosty}), appid=${withAppId}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
