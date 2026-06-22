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
import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as cheerio from "cheerio";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const SITE = "https://www.playground.ru";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const STUDIO = "PlayGround";
const LANGUAGE = "Русский";

// Per the source's nature, the studio is always the portal (uploaders vary and
// aren't the translators); a specific author isn't reliably extractable.
const AUTHOR = "Playground.ru";

// Install differs per russifier and the page's guide is huge/variable, so we
// point the user to the file page (where the guide + download button live).
const HOW_TO_INSTALL =
  `<p>У каждого русификатора на PlayGround — свой способ установки. ` +
  `Откройте страницу русификатора (кнопка «Открыть в браузере» ниже) — там ` +
  `полная инструкция по установке и кнопка загрузки файла.</p>`;

const MAX_PAGES = Number(process.env.PG_MAX_PAGES) || Infinity;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getText(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.text();
}

/* ----------------------------- catalogue index ---------------------------- */

async function fetchCatalogue() {
  const urls = new Map();
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    let html;
    try {
      // Catalogue base is /file/rus (singular, no slash); pagination is ?p=N.
      html = await getText(`${SITE}/file/rus?p=${page}`);
    } catch (err) {
      console.warn(`\n  ! catalogue page ${page}: ${err.message}`);
      break;
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
    await sleep(80);
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
  const neuro = /nejro|neuro|нейро|машинн/.test(s);
  const isText = (/tekst/.test(s) && !/tekstur/.test(s)) || /текст/.test(s);
  const isTextures = /tekstur|текстур/.test(s);
  const isVoice = /ozvuch|озвуч|закадр/.test(s);
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

function buildEntry(url, html) {
  const $ = cheerio.load(html);
  const slug = (url.match(/\/file\/([a-z0-9_-]+)-\d+/i) || [])[1] || "";

  // Game title: h1 is `<Game> "Русификатор …"` — keep the part before the quote.
  const h1 = $("h1").first().text().replace(/\s+/g, " ").trim();
  const title = h1.split(/["«]/)[0].trim() || slug;

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
    studio: AUTHOR,
    studioUrl: url,
    language: LANGUAGE,
    ...typeFlags(slug, `${title} ${variantLabels}`),
    version,
    size: largestSize(html),
    updatedAt: null,
    pageUrl: url,
    howToInstallHtml: HOW_TO_INSTALL,
    inDevelopment: false,
    fileName,
    // Browser-only: the download endpoint bot-blocks our HTTP downloader.
    mirrors: [{ label: STUDIO, url, kind: "other" }],
  };
}

/* ---------------------------------- main ---------------------------------- */

async function main() {
  console.log("[PG] fetching catalogue…");
  const urls = await fetchCatalogue();
  console.log(`[PG] ${urls.length} files`);

  const localizations = [];
  let i = 0;
  for (const url of urls) {
    i += 1;
    try {
      localizations.push(buildEntry(url, await getText(url)));
    } catch (err) {
      console.warn(`\n  ! ${url}: ${err.message}`);
    }
    if (i % 20 === 0 || i === urls.length)
      process.stdout.write(`\r[PG] file ${i}/${urls.length}     `);
    await sleep(90);
  }
  console.log("");

  const file = { name: STUDIO, language: LANGUAGE, category: "aggregator", localizations };
  await mkdir(join(ROOT, "data"), { recursive: true });
  const outPath = join(ROOT, "data", "playground.json");
  await writeFile(outPath, JSON.stringify(file, null, 2), "utf8");

  const neural = localizations.filter((l) => l.hasNeuralText || l.hasNeuralVoice || l.hasNeuralDub).length;
  const guide = localizations.filter((l) => l.howToInstallHtml).length;
  console.log(`[PG] done → ${outPath}`);
  console.log(`[PG] total=${localizations.length}, neural=${neural}, with-guide=${guide}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
