/**
 * Generator: ReVoiceAI -> data/revoiceai.json
 *
 * ReVoiceAI is a neural-dub studio. Unlike SynthVoiceRu, their Boosty posts are
 * self-contained: each game's post links to the file on PlayGround AND to cloud
 * mirrors (ShareMods "Полный дубляж" / "Закадровая озвучка"). So this is fully
 * Boosty-driven — no PlayGround scan needed:
 *   1. list their Boosty posts, read each one's content,
 *   2. keep the "release" posts (those with a PlayGround / ShareMods link),
 *   3. emit one card per game with cloud + PlayGround + Boosty links, type/neural
 *      from the title, and a Steam app id resolved from the game name.
 *
 * Browser-only (ShareMods links are host pages). Category: neural-studio.
 */
import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { sleep, mapPool, getJson, getText } from "../lib/net.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const STUDIO = "ReVoiceAI";
const LANGUAGE = "Русский";
const BOOSTY = "https://boosty.to/revoice";

const HOW_TO_INSTALL =
  `<p>Нейроозвучка от <strong>ReVoiceAI</strong>. Скачай через одно из зеркал ` +
  `выше (ShareMods — облако, PlayGround — их страница) и запусти ` +
  `<code>.exe</code>-установщик, указав путь к игре. Поддержать авторов можно ` +
  `на их <a href="${BOOSTY}">Boosty</a>.</p>`;

const normTitle = (t) =>
  (t || "").toLowerCase().replace(/['’:.,!?®™&–—_-]/g, " ").replace(/\bii\b/g, "2").replace(/\s+/g, " ").trim();

const titleize = (slug) =>
  slug.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim();

const TYPE_TOKEN = "(?:dub|dublyazh|voiceover|zakadr|ozvuchka|polnaya|russkaya|rus|ai|v\\d[\\d.]*)";

/**
 * Game slug from the PG link, else from a ShareMods file name. Opaque cloud
 * hosts (Yandex/Mega/Drive) expose only a hash, so they can't name the game.
 */
function slugFor(pg, cloud) {
  if (pg) return (pg.match(/playground\.ru\/([a-z0-9_-]+)\/file/i) || [])[1] || null;
  const sm = cloud.find((c) => /sharemods/i.test(c.url));
  if (!sm) return null;
  let f = decodeURIComponent(sm.url.split("/").pop() || "").toLowerCase();
  f = f.replace(/\.(zip|rar|7z|html)/g, "");
  // The game name is the prefix before the first localization-type token, so
  // "greedfall_dub_matched" / "greedfall_voiceover" both collapse to "greedfall".
  f = f.replace(new RegExp(`^${TYPE_TOKEN}[_-]`), ""); // leading "dub_"
  f = f.replace(new RegExp(`[_-]${TYPE_TOKEN}(?:[_-].*)?$`), ""); // "_dub_matched", "_voiceover_v2"
  return f.replace(/^[_-]+|[_-]+$/g, "") || null;
}

/** Abbreviations the file names use that won't match the PG slug / Steam name. */
const SLUG_ALIAS = { rdr: "red dead redemption" };

/**
 * Honest mirror label from the link host. The post's own link text is unreliable
 * — it's often a bare URL, and sometimes flat wrong (a "MEGA" caption on a Yandex
 * link), so we name the mirror by where it actually points.
 */
function hostLabel(url) {
  let h = "";
  try {
    h = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    /* malformed */
  }
  const NAMES = [
    [/mega\.nz/, "MEGA"],
    [/sharemods/, "ShareMods"],
    [/yandex/, "Yandex Disk"],
    [/drive\.google/, "Google Drive"],
    [/mediafire/, "MediaFire"],
  ];
  return (NAMES.find(([re]) => re.test(h)) || [, h || "Скачать"])[1];
}

/** File name from a URL path, extension stripped. "" for query-only links. */
const baseName = (url) => {
  try {
    return decodeURIComponent(new URL(url).pathname.split("/").pop() || "").replace(
      /\.(zip|rar|7z|html)/gi,
      " "
    );
  } catch {
    return "";
  }
};

/** Hosts whose URL carries a real file name (so it can name the variant). */
const isNamedHost = (url) => /sharemods|mediafire/i.test(url);

/**
 * "<Host> (<variant>)" — the host plus whatever the file name says beyond the
 * game name (HD / Remastered / Voiceover / Dub …), so two mirrors for the same
 * game are told apart. Opaque hosts (MEGA/Yandex hashes) borrow the variant from
 * the nearest named neighbour (nameHint), then fall back to the post section.
 */
function mirrorLabel(url, slugWords, section, nameHint) {
  const host = hostLabel(url);
  const cap = (w) =>
    ({
      hd: "HD",
      rus: "RUS",
      ai: "ИИ",
      dub: "Дубляж",
      dublyazh: "Дубляж",
      voiceover: "Закадр",
      zakadr: "Закадр",
      ozvuchka: "Озвучка",
    })[w] || w[0].toUpperCase() + w.slice(1);
  const DESC = new Set(["dub", "dublyazh", "voiceover", "zakadr", "ozvuchka", "remastered", "remaster", "extended", "matched", "original", "hd"]);
  const STOP = new Set(["the", "a", "an", "of", "and", "для", "и"]);
  const wordsOf = (name) => normTitle(name || "").split(" ").filter(Boolean);

  // Use the link's own file name; if it's an opaque hash, borrow a named neighbour.
  let words = wordsOf(baseName(url));
  if (!words.some((w) => slugWords.has(w) || DESC.has(w)) && nameHint) words = wordsOf(nameHint);

  // When the name shares words with the game, the leftover words are the variant
  // (HD / Remastered / Dub …). Otherwise keep just the localization-type tokens.
  const keep = (
    words.some((w) => slugWords.has(w))
      ? words.filter((w) => !slugWords.has(w))
      : words.filter((w) => DESC.has(w))
  ).filter((w) => !STOP.has(w));
  let variant = keep.map(cap).join(" ").trim();
  if (!variant && section) variant = section === "dub" ? "Дубляж" : "Закадр";
  return variant ? `${host} (${variant})` : host;
}

/* -------------------------------- Boosty ---------------------------------- */

async function fetchPostList() {
  const posts = [];
  let offset = null;
  for (let g = 0; g < 15; g += 1) {
    const u = `https://api.boosty.to/v1/blog/revoice/post/?limit=50${
      offset ? `&offset=${encodeURIComponent(offset)}` : ""
    }`;
    let j;
    try {
      j = await getJson(u, { headers: { Referer: BOOSTY } });
    } catch {
      break;
    }
    posts.push(...(j.data || []).map((p) => ({ id: p.id, title: (p.title || "").replace(/\s+/g, " ").trim() })));
    if (j.extra?.isLast || !(j.data || []).length) break;
    offset = j.extra?.offset;
    await sleep(120);
  }
  return posts;
}

/** Collects every {type:"link"} node, however deep (list items nest data/items). */
function collectLinks(node, out) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const x of node) collectLinks(x, out);
    return;
  }
  if (node.type === "link" && node.url) out.push(node);
  collectLinks(node.data, out);
  collectLinks(node.items, out);
}

/** Leading text of a block ("🔊 Полный дубляж:") — used to read section headings. */
function blockText(b) {
  if (typeof b.content === "string") {
    try {
      return JSON.parse(b.content)[0] || "";
    } catch {
      /* not JSON */
    }
  }
  return "";
}

/** Reads a post's links: cloud mirrors (url + section) + the PlayGround page. */
async function fetchPostLinks(id) {
  let j;
  try {
    j = await getJson(`https://api.boosty.to/v1/blog/revoice/post/${id}`, {
      headers: { Referer: BOOSTY },
    });
  } catch {
    return { cloud: [], pg: null };
  }
  const cloud = [];
  let pg = null;
  let section = null; // "dub" | "voice" | null — from the nearest heading above
  for (const b of j.data || []) {
    const t = blockText(b).toLowerCase();
    const dub = /дубляж/.test(t);
    const voice = /закадр|озвучк/.test(t);
    if (dub && !voice) section = "dub";
    else if (voice && !dub) section = "voice";
    else if (dub && voice) section = null; // a "dub & voice-over" line — ambiguous

    const links = [];
    collectLinks(b, links); // a list block holds its links in nested items[].data[]
    for (const l of links) {
      let host = "";
      try {
        host = new URL(l.url).hostname;
      } catch {
        /* skip malformed */
      }
      if (/playground\.ru\/[a-z0-9_-]+\/file/i.test(l.url)) pg = l.url;
      // Match on hostname — a youtube.com/redirect carries the real mega.nz link in
      // its ?q=, so testing the whole URL would wrongly capture the redirect wrapper.
      else if (
        /sharemods|yandex|drive\.google|mega\.nz|mediafire/i.test(host) &&
        !cloud.some((c) => c.url === l.url)
      )
        cloud.push({ url: l.url, section });
    }
  }

  // Give each opaque (hash) mirror the file name of its nearest named neighbour —
  // the next one if there is one (mirrors list MEGA then ShareMods), else previous.
  for (let k = 0; k < cloud.length; k += 1) {
    if (isNamedHost(cloud[k].url)) {
      cloud[k].nameHint = baseName(cloud[k].url);
      continue;
    }
    for (let d = 1; d < cloud.length; d += 1) {
      const fwd = cloud[k + d];
      const back = cloud[k - d];
      if (fwd && isNamedHost(fwd.url)) {
        cloud[k].nameHint = baseName(fwd.url);
        break;
      }
      if (back && isNamedHost(back.url)) {
        cloud[k].nameHint = baseName(back.url);
        break;
      }
    }
  }
  return { cloud, pg };
}

/* ----------------------------- type / version ----------------------------- */

/** ReVoiceAI is neural; map дубляж/закадр (title or link labels) to flags. */
function typeFlags(text) {
  const s = (text || "").toLowerCase();
  const dub = /дубляж|dub/.test(s);
  const voice = /закадр|озвучк|voiceover|zakadr|ozvuchka/.test(s);
  return {
    hasText: false,
    hasVoice: false,
    hasTextures: false,
    hasNeuralText: false,
    hasNeuralDub: dub,
    hasNeuralVoice: voice || !dub, // default to voice-over if nothing else
  };
}

const versionFromTitle = (t) =>
  (t.match(/\bv\.?\s?(\d+(?:\.\d+)+)/i) || [])[1] || null;

/* --------------------------- steam app id lookup -------------------------- */

const stripSuffix = (t) => t.replace(/\s*\([^)]*\)\s*$/, "").trim();

// Edition words to ignore so "…Liberation" matches Steam's "…Liberation HD".
const core = (t) =>
  normTitle(t)
    .replace(/\b(hd|remaster(?:ed)?|definitive|goty|complete|enhanced|deluxe|edition|remake)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Steam app id + proper name by exact title match (raw + suffix-stripped). */
async function resolveSteam(name) {
  const variants = [...new Set([name, stripSuffix(name)])];
  const targets = new Set(variants.map(normTitle));
  const coreTargets = new Set(variants.map(core));
  for (const term of variants) {
    try {
      const json = await getJson(
        `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(term)}&cc=us&l=en`
      );
      // Exact match (then edition-insensitive) — a wrong app id attaches the dub
      // to the wrong game, so never fall back to a fuzzy "first result".
      const items = json?.items || [];
      const hit =
        items.find((it) => targets.has(normTitle(it.name))) ||
        items.find((it) => coreTargets.has(core(it.name)));
      if (hit) return { appid: String(hit.id), name: hit.name };
    } catch {
      /* ignore */
    }
    await sleep(180);
  }
  return null;
}

const decodeEntities = (s) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#0?39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));

/** Clean game name from the PG page h1 (drops the "…ИИ-озвучка" descriptor). */
async function titleFromPg(pgUrl) {
  try {
    const html = await getText(pgUrl);
    const h1 = (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || "";
    const txt = decodeEntities(h1.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
    const name = txt
      .split(/["«„]/)[0] // game name comes before the quoted localization title
      .replace(/\s*[.\-—:]\s*(?:Полная|Нейро|Русск|Озвуч|Дубляж|Закадр|Машинн|ИИ).*$/i, "")
      .trim();
    return name || null;
  } catch {
    return null;
  }
}

/* ---------------------------------- main ---------------------------------- */

async function main() {
  console.log("[RV] listing Boosty posts…");
  const posts = await fetchPostList();
  console.log(`[RV] ${posts.length} posts`);

  // Merge ALL posts of a game into one card. The game name comes from the PG
  // slug or the ShareMods file name — NEVER the (emoji-laden) post title.
  const byGame = new Map();
  let i = 0;
  for (const p of posts) {
    i += 1;
    const { cloud, pg } = await fetchPostLinks(p.id);
    if (!pg && !cloud.length) continue;
    const slug = slugFor(pg, cloud);
    if (!slug) continue;
    const raw = slug.replace(/[_-]+/g, " ").trim();
    const key = SLUG_ALIAS[raw] || raw;
    const g = byGame.get(key) || { slug, pg: null, cloud: [], titles: [], postId: null };
    if (pg && !g.pg) {
      g.pg = pg;
      g.slug = (pg.match(/playground\.ru\/([a-z0-9_-]+)\/file/i) || [])[1] || g.slug;
      g.postId = p.id; // prefer the release post (has the PG link) for the Boosty link
    }
    for (const c of cloud) if (!g.cloud.some((x) => x.url === c.url)) g.cloud.push(c);
    g.titles.push(p.title);
    if (!g.postId) g.postId = p.id;
    byGame.set(key, g);
    process.stdout.write(`\r[RV] scanned ${i}/${posts.length}, games ${byGame.size}     `);
    await sleep(120);
  }
  console.log("");

  const localizations = await mapPool([...byGame.values()], 4, async (g) => {
    // Title: the PG page h1 gives the proper game name (apostrophes, "The …");
    // fall back to the slug. Then resolve the Steam app id off that clean name.
    let title = titleize(g.slug);
    if (g.pg) {
      const t = await titleFromPg(g.pg);
      if (t) title = t;
    }
    const steam = await resolveSteam(title);
    const appid = steam?.appid ?? null;
    if (steam) title = steam.name; // canonical Steam name when matched

    // Words of the game name, to subtract from file names when labelling mirrors.
    const slugWords = new Set(normTitle(g.slug).split(" ").filter(Boolean));
    // Type comes from the post titles + the mirror file names (…_dub, …_voiceover).
    const text = `${g.titles.join(" ")} ${g.cloud.map((c) => c.url).join(" ")}`;
    return {
      steamAppId: appid ?? undefined,
      title,
      studio: STUDIO,
      studioUrl: BOOSTY,
      language: LANGUAGE,
      ...typeFlags(text),
      version: g.titles.map(versionFromTitle).find(Boolean) || null,
      updatedAt: null,
      pageUrl: g.pg || `${BOOSTY}/posts/${g.postId}`,
      howToInstallHtml: HOW_TO_INSTALL,
      inDevelopment: false,
      mirrors: [
        ...g.cloud.map((c) => ({
          label: mirrorLabel(c.url, slugWords, c.section, c.nameHint),
          url: c.url,
          kind: "other",
        })),
        { label: "Boosty (поддержать авторов)", url: `${BOOSTY}/posts/${g.postId}`, kind: "other" },
      ],
    };
  });

  const file = { name: STUDIO, language: LANGUAGE, category: "neural-studio", siteUrl: BOOSTY, localizations };
  await mkdir(join(ROOT, "data"), { recursive: true });
  const outPath = join(ROOT, "data", "revoiceai.json");
  await writeFile(outPath, JSON.stringify(file, null, 2), "utf8");

  const appid = localizations.filter((l) => l.steamAppId).length;
  const withPg = localizations.filter((l) => /playground\.ru/.test(l.pageUrl)).length;
  console.log(`[RV] done → ${localizations.length} games (appid=${appid}, on-PG=${withPg})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
