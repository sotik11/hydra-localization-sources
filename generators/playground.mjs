/**
 * Generator: PlayGround.ru (playground.ru/files/rus) -> data/playground.json
 *
 * Huge Russian localization aggregator. Pages are server-rendered (curl sees the
 * full HTML: title, file name, size, author, "Установка" guide, type). The
 * download endpoint /files/download/<id> is bot-blocked for non-browser clients
 * AND needs a session — so in-app download is impossible. This is therefore a
 * **browser-only** metadata source: the mirror is the file page ("Открыть на
 * PlayGround"), where the user clicks "скачать файл".
 *
 * No Steam app id is exposed -> title matching (PlayGround names match Steam
 * closely). Type / neural is encoded in the file slug
 * (…rusifikator_teksta_nejroperevod / _ozvuchka / _nejrodublyazh).
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as cheerio from "cheerio";
import { UA, sleep, fetchTimeout, mapPool, getText, normalizeSize } from "../lib/net.mjs";
import { resolveSteamAppIdWithScore } from "../lib/steam-search.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const SITE = "https://www.playground.ru";

const STUDIO = "PlayGround";
const LANGUAGE = "Русский";

// The studio is always the portal (PlayGround); the per-translation author (the
// {brace} tag in the title) goes into the Authors modal instead.

// Install differs per russifier and the page's guide is huge/variable, so we
// point the user to the file page (where the guide + download button live).
const HOW_TO_INSTALL =
  `<p>У каждого русификатора на PlayGround — свой способ установки. ` +
  `Откройте страницу русификатора (кнопка «Открыть в браузере» ниже) — там ` +
  `полная инструкция по установке и кнопка загрузки файла.</p>`;

const MAX_PAGES = Number(process.env.PG_MAX_PAGES) || Infinity;


/* ----------------------------- catalogue index ---------------------------- */

async function fetchCatalogue() {
  const urls = new Map();
  let fails = 0;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    let html;
    try {
      // Catalogue base is /file/rus (singular, no slash); pagination is ?p=N.
      html = await getText(`${SITE}/file/rus?p=${page}`);
      fails = 0;
    } catch (err) {
      console.warn(`\n  ! catalogue page ${page}: ${err.message}`);
      // One throttled page must not truncate the whole catalogue — skip it and
      // keep walking. Only bail after many consecutive hard failures, and give
      // the site a real cooldown between attempts (it 503s us under load).
      fails += 1;
      if (fails >= 6) break;
      await sleep(5000);
      continue;
    }
    const found = [
      ...new Set((html.match(/\/[a-z0-9_-]+\/file\/[a-z0-9_-]+-\d+/gi) || [])),
    ];
    const before = urls.size;
    for (const u of found) {
      const id = u.match(/-(\d+)$/)[1];
      urls.set(id, SITE + u);
    }
    process.stdout.write(`\r[PG] catalogue page ${page}, ${urls.size} files     `);
    if (urls.size === before) break; // past the last page (no new files)
    await sleep(50);
  }
  console.log("");
  return [...urls.values()];
}

/* ------------------------------- file page -------------------------------- */

/**
 * Type / neural flags from the file slug AND the title — "нейро/машинный" and
 * the modality are often stated in the title ("Нейросетевая озвучка"), not just
 * the slug, so we read both.
 */
function typeFlags(slug, title) {
  const s = (slug + " " + (title || "")).toLowerCase();
  // "Нейро…", "Машинный", "Нейросетевой", "ИИ-озвучка" — and a translation made
  // "с помощью DeepSeek/ChatGPT/…" (a named AI model) — all mean AI-generated.
  // Named AI models + neural TTS tools (a translation made "by" one is AI).
  const aiModel =
    /deepseek|chatgpt|gpt[\s_-]?[0-9o]|\bclaude\b|gemini|gigachat|yandexgpt|\bdeepl\b|\bllama\b|mistral|\bqwen\b|copilot|revoiceai|elevenlabs|silero|\bxtts\b|tortoise|\brvc\b/i;
  const neuro =
    /nejro|neuro|нейро|машинн|mashinn|ии[\s_-]?(?:озвуч|дубляж|перевод|текст)|ii[_-](?:ozvuch|dub|perevod|tekst)|от[\s_-]?ии(?:[\s_).\]]|$)|ot[\s_-]ii(?:[\s_]|$)/.test(
      s
    ) || aiModel.test(s);
  const isText = (/tekst/.test(s) && !/tekstur/.test(s)) || /текст/.test(s);
  const isTextures = /tekstur|текстур/.test(s);
  // "звук"/"голос" are as common as "озвучка" on PlayGround ("русификатор
  // звука"); without them the entry matched no modality and fell back to text.
  // "видео" is deliberately absent: it is ambiguous ("видеосубтитры" is text)
  // and collides with real game names ("The Video Game", "The Videogame").
  const isVoice = /ozvuch|озвуч|закадр|zvuk|звук|golos|голос/.test(s);
  const isDub = /dublyazh|dubljazh|dubl|дубляж/.test(s);
  const flags = {
    hasText: isText && !neuro,
    hasVoice: (isVoice || isDub) && !neuro,
    hasTextures: isTextures,
    hasNeuralText: neuro && isText,
    hasNeuralVoice: neuro && isVoice,
    hasNeuralDub: neuro && isDub,
  };
  // No modality token in the slug -> assume text (the common russifier case).
  if (!Object.values(flags).some(Boolean)) flags.hasText = true;
  return flags;
}

/** "1.27 Гб" -> bytes (for comparing several variant sizes on one page). */
function sizeToBytes(s) {
  const m = s.match(/([\d.,]+)\s*([КМГ]?)и?[Бб]/i);
  if (!m) return 0;
  const mult = { К: 1e3, М: 1e6, Г: 1e9, "": 1 }[m[2].toUpperCase()] ?? 1;
  return parseFloat(m[1].replace(",", ".")) * mult;
}

/** Largest size among a page's download variants (data-size="1.27 Гб"). */
function largestSize(html) {
  const sizes = [...new Set([...html.matchAll(/data-size="([^"]+)"/gi)].map((m) => m[1]))];
  if (!sizes.length) return null;
  return sizes.sort((a, b) => sizeToBytes(b) - sizeToBytes(a))[0];
}

// Only real russifiers (the /file/rus feed also lists mods like "Hotscenes").
const RUSSIFIER_RE =
  /rusifikator|rusifikatsiya|rusik|perevod|pereklad|lokaliz|ozvuch|dublyazh|dubljazh|nejro|mashinn|_teksta|tekst_/i;
// Mods that merely *mention* a translation (the localization is secondary):
// fixes, cheats, trainers, adult mods, etc.
// Mods that merely *mention* a translation (the localization is secondary):
// fixes, cheats, adult mods, and "<mod> с русским переводом / с переводом".
const MOD_RE =
  /ispravleni|_mod[_-]|cheat|trener|trainer|\bseks|18_plus|hotscenes|basemental|s_russkim_perevodom|s_russkim_yazykom|s_perevodom/i;
// Studios we already have as their own (better) source — a PlayGround re-upload
// of their work is a duplicate, so drop it.
const KNOWN_STUDIO_SLUG_RE =
  /gamesvoice|mechanics[\s_-]?voiceover|r[\s_.-]?g[\s_.-]?mvo|siberian[\s_-]?studio|shlyakbitraf|revoiceai/i;
const KNOWN_STUDIOS = new Set([
  "gamesvoice",
  "mechanicsvoiceover",
  "mvo",
  "rgmvo",
  "siberianstudio",
  "шлякбитраф",
  "grajpopolsku",
  "magyaritasok",
  "kuli",
  "кулі",
  "lbk",
  "revoiceai",
]);
const normStudio = (n) => (n || "").toLowerCase().replace(/[^a-zа-яё0-9]/gi, "");
const isKnownStudio = (n) => KNOWN_STUDIOS.has(normStudio(n));
const isRussifier = (slug) =>
  RUSSIFIER_RE.test(slug) && !MOD_RE.test(slug) && !KNOWN_STUDIO_SLUG_RE.test(slug);

/** Per-entry language — the /file/rus feed sometimes has BY/UA/EN, named in the title. */
function detectLanguage(slug, title) {
  const s = (slug + " " + (title || "")).toLowerCase();
  if (/belorussk|білорус|белорус|беларус/.test(s)) return "Белорусский";
  if (/ukrainsk|україн|украинск/.test(s)) return "Українська";
  if (/anglijsk|английск|na_english/.test(s)) return "English";
  return "Русский";
}

/**
 * Strips the localization descriptor from the h1 to get the bare game name:
 *   `Starfield "Русификатор текста"`        -> Starfield   (quoted)
 *   `Batman: Arkham Origins. Нейросетевая…` -> Batman: Arkham Origins (". <desc>")
 */
function cleanTitle(h1, slug) {
  let t = h1.replace(/\s+/g, " ").trim();
  t = t.replace(/\{[^}]*\}/g, " ").trim(); // drop author tag {SynthVoiceRu}
  t = t.split(/["«]/)[0].trim();
  // Leading descriptor: "Русификатор [текста и озвучки] <Game>".
  t = t
    .replace(
      /^(?:Русификатор|Русифікатор|Русик|Локализаци\w+|Локалізаці\w+|Перевод|Переклад|Нейроперевод|Нейроозвучк\w+|Озвучк\w+|Дубляж)(?:\s+(?:текста|озвучки|звука|речи|и|интерфейса|графики|текстур|полн\w+|русск\w+|для|на|от))*\s+/i,
      ""
    )
    .trim();
  // Trailing descriptor after ". / - / :".
  // "Русификация" / "Русифікація" are the noun-forms that slipped past the
  // stem list above — added explicitly.
  t = t
    .replace(
      /\s*[.\-—:]\s*(?:Русификатор|Русифікатор|Русификаци\w+|Русифікаці\w+|Локализац|Перевод|Нейро|Озвуч|Дубляж|Закадр|Текстур|Машинн|Полная локал|Любительск)[\s\S]*$/i,
      ""
    )
    .trim();
  // Trailing junk: "+ Фикс", "и патч…", "[Steam]…", "[vX]".
  t = t
    .replace(/\s*(?:[+]\s[\s\S]*|и\s+(?:патч|фикс|исправлени)\w*[\s\S]*|\[[^\]]*\][\s\S]*)$/i, "")
    .trim();
  // If the quote-split or trailing-junk stripping above cut inside a
  // parenthetical (e.g. "Dragon Age: Origins (+ Awakening, + DLC)" -> the
  // "+ Awakening..." gets stripped and we're left with a dangling "("),
  // drop the dangling open bracket at the very end. Must run AFTER trailing
  // junk so it can catch the newly-exposed bracket.
  t = t.replace(/\s*[\(\[\{]\s*$/, "").trim();
  return t || slug;
}

function buildEntry(url, html) {
  const $ = cheerio.load(html);
  const slug = (url.match(/\/file\/([a-z0-9_-]+)-\d+/i) || [])[1] || "";

  const h1 = $("h1").first().text().replace(/\s+/g, " ").trim();
  const title = cleanTitle(h1, slug);
  // ~90% of titles end with the team in braces: "… {SynthVoiceRu}".
  const braceAuthor = (h1.match(/\{([^}]+)\}/) || [])[1]?.trim();
  // A re-upload of a studio we already have (e.g. {GamesVoice}) is a duplicate.
  if (braceAuthor && isKnownStudio(braceAuthor)) return null;

  // The download filename is in the page (archive preferred over a game .exe
  // that the install guide might mention). Size is JS-rendered, so unavailable.
  const fileName =
    (html.match(/\b[A-Za-z0-9][\w.-]*\.(?:zip|rar|7z)\b/) || [])[0] ||
    (html.match(/\b[A-Za-z0-9][\w.-]*\.exe\b/) || [])[0] ||
    null;
  // Version is shown as "[vX.Y]" (current one first); size is JS-rendered only.
  const version =
    (html.match(/\[v(\d+(?:[._]\d+)*)\]/i) || [])[1]?.replace(/_/g, ".") ||
    (fileName && (fileName.match(/v(\d+(?:[._]\d+)+)/i) || [])[1]?.replace(/_/g, ".")) ||
    null;

  // A page can list several variants (дубляж / закадр / 2-in-1). We keep ONE
  // card (the link goes to the page with all of them anyway) but collect every
  // variant's type label so all the badges show, and use the largest size.
  const variantLabels = (html.match(/\((?:дубляж|закадр|озвучк[аи]|текст)[^)]{0,15}\)/gi) || []).join(" ");

  return {
    title,
    // Aggregator: the studio is always the portal; the actual translator (the
    // {brace} author) goes into the Authors modal instead.
    studio: STUDIO,
    studioUrl: url,
    authorsHtml: braceAuthor ? `<p>${braceAuthor}</p>` : null,
    language: detectLanguage(slug, h1),
    // Detect type/neural from the RAW h1 (the descriptor cleanTitle stripped).
    ...typeFlags(slug, `${h1} ${variantLabels}`),
    version,
    size: normalizeSize(largestSize(html)),
    updatedAt: null,
    pageUrl: url,
    howToInstallHtml: HOW_TO_INSTALL,
    inDevelopment: false,
    fileName,
    // Browser-only: the download endpoint bot-blocks our HTTP downloader.
    mirrors: [{ label: STUDIO, url, kind: "other" }],
  };
}

/* --------------------------- steam app id lookup -------------------------- */
// Uses the shared lib/steam-search.mjs helper — variant generation, 4-level
// fuzzy scoring, series-number sanity, type=app filter.

/* ---------------------------------- main ---------------------------------- */

const TYPE_FLAGS = [
  "hasText",
  "hasVoice",
  "hasTextures",
  "hasNeuralText",
  "hasNeuralVoice",
  "hasNeuralDub",
];

async function main() {
  console.log("[PG] fetching catalogue…");
  const urls = await fetchCatalogue();
  // Drop non-russifiers (mods) up front, by slug — saves fetching their pages.
  const russifiers = urls.filter((u) =>
    isRussifier((u.match(/\/file\/([a-z0-9_-]+)-\d+/i) || [])[1] || "")
  );
  console.log(`[PG] ${urls.length} files, ${russifiers.length} russifiers`);

  let done = 0;
  const built = (
    await mapPool(russifiers, 4, async (url) => {
      let entry = null;
      try {
        entry = buildEntry(url, await getText(url));
      } catch (err) {
        console.warn(`\n  ! ${url}: ${err.message}`);
      }
      done += 1;
      if (done % 20 === 0 || done === russifiers.length)
        process.stdout.write(`\r[PG] file ${done}/${russifiers.length}     `);
      return entry;
    })
  ).filter(Boolean);
  console.log("");

  // Dedup: same game + same type combo = different versions -> keep the newest
  // (catalogue is newest-first, so the first occurrence wins).
  const byKey = new Map();
  for (const e of built) {
    const sig = TYPE_FLAGS.filter((f) => e[f]).join(",");
    const key = `${e.title.toLowerCase()}|${sig}`;
    if (!byKey.has(key)) byKey.set(key, e);
  }
  const localizations = [...byKey.values()];
  console.log(`[PG] ${built.length} -> ${localizations.length} after dedup`);

  // Resolve a Steam app id by title (cached per game) for exact matching + grid.
  // Cache the PROMISE so concurrent duplicates share one request, not race it.
  const appCache = new Map();
  const resolveCached = (title) => {
    const key = title.toLowerCase();
    if (!appCache.has(key)) appCache.set(key, resolveSteamAppIdWithScore(title));
    return appCache.get(key);
  };
  const candidates = [];
  const seenCandidates = new Set();
  let j = 0;
  await mapPool(localizations, 4, async (e) => {
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
    if (j % 20 === 0 || j === localizations.length)
      process.stdout.write(`\r[PG] appid ${j}/${localizations.length}     `);
  });
  console.log("");

  await mkdir(join(ROOT, "data"), { recursive: true });

  // Drop aggregator cards that duplicate a studio source's own voice-over (same
  // Steam app id) — e.g. ReVoiceAI uploads its dubs to PlayGround too, but those
  // games belong to the richer ReVoiceAI card, not here. A *text* russifier of
  // the same game is a different localization and stays.
  const STUDIO_VOICE_SOURCES = ["revoiceai.json"];
  const studioVoiceIds = new Set();
  for (const f of STUDIO_VOICE_SOURCES) {
    try {
      const j = JSON.parse(await readFile(join(ROOT, "data", f), "utf8"));
      for (const l of j.localizations || []) if (l.steamAppId) studioVoiceIds.add(String(l.steamAppId));
    } catch {
      /* studio source not generated yet — skip */
    }
  }
  const isVoiceCard = (l) => l.hasVoice || l.hasNeuralVoice || l.hasNeuralDub;
  const beforeDrop = localizations.length;
  const deduped = localizations.filter(
    (l) => !(l.steamAppId && studioVoiceIds.has(l.steamAppId) && isVoiceCard(l))
  );
  console.log(`[PG] dropped ${beforeDrop - deduped.length} studio-source voice duplicates`);

  // SynthVoiceRu (a neural-voice studio) gets its own source; synthvoiceru.mjs
  // then enriches it with Boosty links + Boosty-only projects.
  // studio is now always "PlayGround", so split SynthVoiceRu off by its author.
  const isSynth = (l) => /SynthVoiceRu/i.test(l.authorsHtml || "");
  const synth = deduped.filter(isSynth);
  const rest = deduped.filter((l) => !isSynth(l));

  await writeFile(
    join(ROOT, "data", "playground.json"),
    JSON.stringify(
      { name: STUDIO, language: LANGUAGE, category: "aggregator", siteUrl: SITE, localizations: rest },
      null,
      2
    ),
    "utf8"
  );
  await writeFile(
    join(ROOT, "data", "synthvoiceru.json"),
    JSON.stringify(
      { name: "SynthVoiceRu", language: LANGUAGE, category: "neural-studio", siteUrl: "https://boosty.to/synthvoiceru", localizations: synth },
      null,
      2
    ),
    "utf8"
  );

  const appid = rest.filter((l) => l.steamAppId).length;
  const neural = rest.filter((l) => l.hasNeuralText || l.hasNeuralVoice || l.hasNeuralDub).length;
  console.log(`[PG] done → playground=${rest.length} (appid=${appid}, neural=${neural}), synthvoiceru=${synth.length}`);

  await writeFile(
    join(ROOT, "data", "playground.candidates.json"),
    JSON.stringify(candidates, null, 2),
    "utf8"
  );
  const nulls = candidates.filter((c) => !c.appId).length;
  const low = candidates.filter((c) => c.appId && c.score < 100).length;
  console.log(
    `[PG] candidates → nulls=${nulls}, sub-100=${low} (written to data/playground.candidates.json)`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
