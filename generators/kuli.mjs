/**
 * Generator: КУЛІ / KÜLI (kuli.com.ua) -> data/kuli.json
 *
 * A large Ukrainian localization catalogue (ASP.NET, server-rendered). Most of
 * its 3000+ games are OFFICIALLY localized (nothing to download) — we only scan
 * the "unofficial" + "semi-official" subsets, which is where fan downloads live:
 *   /games?tags=non-off   (~961)   /games?tags=semi-off  (~80)
 *
 * Per game page: an EXACT Steam app id is embedded, plus translation cards
 * (.product__translate-item) with status / date / type / author / a download
 * button /download/translate/<id>. That endpoint either streams a kuli-hosted
 * archive (a real in-app `direct` download) or 302s to a cloud (Google Drive,
 * Yandex, Mega, …). LBK and bare store/forum links are dropped.
 *
 * Machine-edited ("Машинний") cards set the neural flags; combined with the type
 * (Текст / Озвучення / Дубляж) they map to hasNeural{Text,Voice,Dub}.
 */
import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as cheerio from "cheerio";
import { UA, sleep, fetchTimeout, mapPool, getText, formatBytes } from "../lib/net.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const SITE = "https://kuli.com.ua";

const STUDIO = "КУЛІ";
const LANGUAGE = "Українська";

// Which official-status subsets to scan (env override for quick test runs).
const TAGS = (process.env.KULI_TAGS || "non-off,semi-off").split(",");
const MAX_PAGES = Number(process.env.KULI_MAX_PAGES) || Infinity;

// Our standard install guide, translated to Ukrainian (per-card guide varies, so
// we use a safe generic one).
const HOW_TO_INSTALL =
  `<ol>` +
  `<li>Завантаж українізатор за посиланням вище.</li>` +
  `<li>Якщо це інсталятор (.exe) — запусти його; якщо архів — розпакуй.</li>` +
  `<li>Скопіюй файли до теки з грою (за запиту — замінити файли).</li>` +
  `<li>Запусти гру — локалізація має застосуватися. Інколи мову треба ` +
  `вибрати в налаштуваннях гри.</li>` +
  `</ol>`;

/* ----------------------------- catalogue index ---------------------------- */

function parseCatalogue(html) {
  const $ = cheerio.load(html);
  const games = [];
  const seen = new Set();
  $("a[href^='/']").each((_, a) => {
    const href = $(a).attr("href") || "";
    if (!/^\/[a-z0-9-]{3,}$/.test(href) || !$(a).find("img").length) return;
    const slug = href.slice(1);
    if (seen.has(slug)) return;
    seen.add(slug);
    games.push({ slug });
  });

  let lastPage = 1;
  for (const m of html.matchAll(/pagenumber=(\d+)/g)) {
    lastPage = Math.max(lastPage, Number(m[1]));
  }
  return { games, lastPage };
}

async function fetchCatalogue() {
  const bySlug = new Map();
  for (const tag of TAGS) {
    const first = parseCatalogue(await getText(`${SITE}/games?tags=${tag}&pagenumber=1`));
    const lastPage = Math.min(first.lastPage, MAX_PAGES);
    for (const g of first.games) bySlug.set(g.slug, g);
    for (let page = 2; page <= lastPage; page += 1) {
      try {
        const { games } = parseCatalogue(
          await getText(`${SITE}/games?tags=${tag}&pagenumber=${page}`)
        );
        for (const g of games) bySlug.set(g.slug, g);
      } catch (err) {
        console.warn(`\n  ! ${tag} page ${page}: ${err.message}`);
      }
      await sleep(70);
    }
  }
  return [...bySlug.values()];
}

/* ------------------------------- download --------------------------------- */

const CLOUD_RULES = [
  { host: /drive\.google/i, kind: "google", label: "Google Drive" },
  { host: /disk\.yandex/i, kind: "yandex", label: "Яндекс.Диск" },
  { host: /mega\.nz/i, kind: "other", label: "MEGA" },
  { host: /dropbox/i, kind: "other", label: "Dropbox" },
  { host: /mediafire/i, kind: "other", label: "MediaFire" },
];

/**
 * Resolves /download/translate/<id> and classifies the destination:
 *   - stays on kuli.com.ua with an archive type  -> { kind: "direct" } (in-app)
 *   - a known cloud host                          -> cloud mirror
 *   - lbklauncher / store / forum / unknown       -> null (dropped)
 */
async function resolveDownload(id) {
  let res;
  try {
    res = await fetchTimeout(`${SITE}/download/translate/${id}`, {
      headers: { "User-Agent": UA, Range: "bytes=0-0" },
      redirect: "follow",
    });
  } catch {
    return null;
  }
  const url = res.url;
  const type = res.headers.get("content-type") || "";

  if (/lbklauncher|lbk\./i.test(url)) return null;

  for (const rule of CLOUD_RULES) {
    if (rule.host.test(url)) {
      return { label: rule.label, url, kind: rule.kind, size: null };
    }
  }

  // kuli-hosted file streamed directly (no redirect) => in-app downloadable. The
  // server ignores our Range probe and returns the whole file, so Content-Length
  // is the real file size.
  if (/kuli\.com\.ua/i.test(url) && !/text\/html/i.test(type)) {
    return {
      label: STUDIO,
      url: `${SITE}/download/translate/${id}`,
      kind: "direct",
      size: formatBytes(Number(res.headers.get("content-length"))),
    };
  }

  // store page / github / nexus / anything else: not a clean download.
  return null;
}

/* ------------------------------- game page -------------------------------- */

/**
 * KÜLI encodes modality in class suffixes (item__param-value--text / --sound /
 * --dub), more reliable than the label. A "full" localization nests them
 * (--sound wrapping --text => text + voice), so we collect ALL suffixes present.
 * The neural flag is orthogonal (machine-edited cards).
 */
function typeFlags(suffixes, machine) {
  const has = (s) => suffixes.includes(s);
  const isText = has("text");
  const isDub = has("dub") || has("dubbing");
  const isVoice = has("sound") || isDub;
  return {
    hasText: isText && !machine,
    hasVoice: isVoice && !machine,
    hasNeuralText: isText && machine,
    hasNeuralVoice: has("sound") && !isDub && machine,
    hasNeuralDub: isDub && machine,
  };
}

async function buildEntries(game) {
  const pageUrl = `${SITE}/${game.slug}`;
  const html = await getText(pageUrl);
  const $ = cheerio.load(html);

  const appId = (html.match(/store\.steampowered\.com\/app\/(\d+)/) || [])[1];
  const title = $("h1").first().text().replace(/\s+/g, " ").trim() || game.slug;

  const entries = [];
  const cards = $(".product__translate-item").toArray();
  for (const el of cards) {
    const $c = $(el);
    const idMatch = ($c.find("a[href*='/download/translate/']").attr("href") || "").match(
      /\/download\/translate\/(\d+)/
    );
    if (!idMatch) continue; // official / no download

    const params = {};
    let typeSuffixes = [];
    $c.find(".item__param").each((_, p) => {
      const k = $(p).find(".item__param-title").text().replace(/\s+/g, " ").trim();
      const v = $(p).find(".item__param-value").first().text().replace(/\s+/g, " ").trim();
      if (k) params[k.replace(/:$/, "")] = v;
      if (/Тип/i.test(k)) {
        // "Повна" nests --sound > --text, so collect every suffix present.
        typeSuffixes = [
          ...new Set(
            $(p)
              .find("[class*='item__param-value--']")
              .map((_, e) => (e.attribs.class.match(/item__param-value--(\w+)/) || [])[1])
              .get()
          ),
        ];
      }
    });

    const machine =
      ($c.attr("class") || "").includes("machine-edited") ||
      $c.find("[class*='machine-edited']").length > 0 ||
      /Машинн/i.test($c.text());

    const mirror = await resolveDownload(idMatch[1]);
    if (!mirror) continue; // lbk / store page / unresolved

    // The real translator is in the summary ("Українізатор від X." / "… від X
    // через …"); the header name is just KÜLI's grouping account ("Спільнота").
    const summary = $c.find(".item__summary").text().replace(/\s+/g, " ").trim();
    const author =
      (summary.match(/від\s+([^.]+)/i)?.[1] || "")
        // cut trailing clauses ("… через майстерню Steam", "… додається …")
        .split(/\s+(?:через|додаєт|доступ|можна)/i)[0]
        .replace(/[,\s]+$/, "")
        .trim() ||
      $c.find(".header__autor-name").first().text().replace(/\s+/g, " ").trim();
    const readiness = params["Готовність"] || "";

    entries.push({
      steamAppId: appId ?? undefined,
      title,
      // Aggregator: the card shows the portal (КУЛІ); the actual translator goes
      // into the Authors modal.
      studio: STUDIO,
      studioUrl: pageUrl,
      language: LANGUAGE,
      ...typeFlags(typeSuffixes, machine),
      version: null,
      updatedAt: params["Останнє оновлення"] || null,
      pageUrl,
      howToInstallHtml: HOW_TO_INSTALL,
      authorsHtml: author ? `<p>${author}</p>` : null,
      size: mirror.size ?? null,
      inDevelopment: /\d/.test(readiness) && !/100/.test(readiness),
      mirrors: [mirror],
    });
    await sleep(100);
  }
  return entries;
}

/* ---------------------------------- main ---------------------------------- */

async function main() {
  console.log(`[KÜLI] fetching catalogue (tags: ${TAGS.join(", ")})…`);
  const games = await fetchCatalogue();
  console.log(`[KÜLI] ${games.length} candidate games`);

  // buildEntries does a page fetch + a download-resolve per card; a fixed pool
  // turns the ~900-game sequential crawl into a few minutes.
  let scanned = 0;
  let kept = 0;
  const built = await mapPool(games, 4, async (game) => {
    let entries = [];
    try {
      entries = await buildEntries(game);
    } catch (err) {
      console.warn(`\n  ! ${game.slug}: ${err.message}`);
    }
    scanned += 1;
    kept += entries.length;
    if (scanned % 20 === 0 || scanned === games.length)
      process.stdout.write(`\r[KÜLI] scanned ${scanned}/${games.length}, kept ${kept}        `);
    return entries;
  });
  const localizations = built.flat();
  console.log("");

  const file = { name: STUDIO, language: LANGUAGE, category: "aggregator", siteUrl: SITE, localizations };
  await mkdir(join(ROOT, "data"), { recursive: true });
  const outPath = join(ROOT, "data", "kuli.json");
  await writeFile(outPath, JSON.stringify(file, null, 2), "utf8");

  const direct = localizations.filter((l) => l.mirrors[0]?.kind === "direct").length;
  const cloud = localizations.length - direct;
  const appid = localizations.filter((l) => l.steamAppId).length;
  const neural = localizations.filter((l) => l.hasNeuralText || l.hasNeuralVoice || l.hasNeuralDub).length;
  console.log(`[KÜLI] done → ${outPath}`);
  console.log(
    `[KÜLI] total=${localizations.length}, direct=${direct}, cloud=${cloud}, steam-appid=${appid}, neural=${neural}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
