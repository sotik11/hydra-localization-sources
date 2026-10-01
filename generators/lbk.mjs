/**
 * Generator: LBK (lbklauncher.com) -> data/lbk.json
 *
 * LBK is a launcher/platform aggregating Ukrainian fan localizations from many
 * teams. It exposes a self-hosted Supabase REST API with a NATIVE steam_app_id
 * (so no title->appid resolution needed). Downloads are NOT available as direct
 * links: they go through a rate-limited, tracked Edge Function that returns
 * short-lived signed URLs. So this is a metadata-only source — every entry has
 * no mirrors and a custom "how to install" that points users to the launcher.
 *
 * The anon key is the public client key (shipped in their site bundle and
 * launcher by design); it only allows the same read access the site itself has.
 * LBK rotates it now and then (2026-08-09: the embedded key started answering
 * 401 and the feed silently froze for two months), so the embedded copy is only
 * a first guess — on a 401 the current key is read from the public site bundle.
 */
import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getJson, getText } from "../lib/net.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const SUPABASE = "https://supabase.lbklauncher.com";
const ANON =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzg2MjkzMjcxLCJleHAiOjIxMDE2NTMyNzF9.EfWNGG8mp6Ck5HfQBMnWJolQ-ykUMPLwzGsMMlJUuIw";
const SITE = "https://lbklauncher.com";

const SOURCE_NAME = "LBK";
const LANGUAGE = "Українська";

const JWT_RE = /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;

/** `iat` of a Supabase anon JWT, or -1 if the token is something else. */
function anonIssuedAt(jwt) {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));
    return payload.role === "anon" && payload.iss === "supabase" ? (payload.iat ?? 0) : -1;
  } catch {
    return -1;
  }
}

/** The anon key the site itself ships to every visitor (newest one in the bundle). */
async function discoverAnonKey() {
  const home = await getText(SITE);
  const chunks = [...new Set(home.match(/\/_next\/static\/chunks\/[^"'\\]+\.js/g) || [])];
  let best = null;
  let bestIat = -1;
  const scan = (text) => {
    for (const key of text.match(JWT_RE) || []) {
      const iat = anonIssuedAt(key);
      if (iat > bestIat) [best, bestIat] = [key, iat];
    }
  };
  scan(home);
  for (const chunk of chunks) {
    try {
      scan(await getText(SITE + chunk));
    } catch {
      // one unreadable chunk is fine as long as the key turns up in another
    }
  }
  if (!best) throw new Error(`[LBK] no anon key found in the site bundle (${chunks.length} chunks scanned)`);
  return best;
}

async function fetchGames(key) {
  const url =
    `${SUPABASE}/rest/v1/games?select=name,slug,steam_app_id,team,status,` +
    `translation_progress,version,archive_path,voice_archive_path,updated_at,` +
    `translation_updated_at` +
    `&approved=eq.true&hide=eq.false&order=name.asc&limit=2000`;
  // tries: 1 — a 401 will not get better on a retry.
  return getJson(url, { headers: { apikey: key, Authorization: `Bearer ${key}` }, tries: 1 });
}

/** Games via the embedded key; if it has been rotated (401), via the site's current one. */
async function fetchGamesWithKeyRecovery() {
  try {
    return await fetchGames(ANON);
  } catch (err) {
    if (!/->\s*401\b/.test(err.message)) throw err;
    console.log("[LBK] embedded anon key rejected (401) — reading the current one from the site bundle…");
    return fetchGames(await discoverAnonKey());
  }
}

/** "2026-03-09T13:29:03Z" -> "09.03.2026" */
function formatDate(iso) {
  const m = (iso ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : null;
}

const HOW_TO_INSTALL =
  `<p>Локалізація встановлюється лише через лаунчер <strong>LBK</strong> — ` +
  `прямого завантаження файлу немає.</p>` +
  `<ol>` +
  `<li>Завантажте LBK Launcher — безкоштовну програму для встановлення ` +
  `українських перекладів ігор із <a href="${SITE}">${SITE}</a>.</li>` +
  `<li>Знайдіть гру у каталозі ігор лаунчера</li>` +
  `<li>Натисніть "Встановити" — переклад автоматично завантажиться та встановиться</li>` +
  `<li>Запустіть гру та насолоджуйтеся українською локалізацією!</li>` +
  `</ol>`;

function buildEntry(game) {
  const pageUrl = `${SITE}/games/${game.slug}`;
  return {
    steamAppId:
      game.steam_app_id != null ? String(game.steam_app_id) : undefined,
    title: game.name,
    // Aggregator: the card shows the portal (LBK); the translating team (from
    // the API) goes into the Authors modal.
    studio: SOURCE_NAME,
    studioUrl: SITE,
    language: LANGUAGE,
    hasText: Boolean(game.archive_path),
    hasVoice: Boolean(game.voice_archive_path),
    version: game.version ?? null,
    // translation_updated_at is when the TRANSLATION changed; updated_at is the
    // row's last write and moves on any edit (2/3 of the catalogue "updated" in
    // one month), so it is only the fallback.
    updatedAt: formatDate(game.translation_updated_at ?? game.updated_at),
    pageUrl,
    howToInstallHtml: HOW_TO_INSTALL,
    authorsHtml: game.team ? `<p>${String(game.team).trim()}</p>` : null,
    inDevelopment: (game.translation_progress ?? 100) < 100,
    // No mirrors — downloads are gated behind LBK's tracked Edge Function.
    mirrors: [],
  };
}

async function main() {
  console.log("[LBK] fetching games…");
  const games = (await fetchGamesWithKeyRecovery()).filter((g) => g.name);
  console.log(`[LBK] ${games.length} games`);

  const localizations = games.map(buildEntry);

  const file = { name: SOURCE_NAME, language: LANGUAGE, category: "aggregator", siteUrl: SITE, localizations };
  await mkdir(join(ROOT, "data"), { recursive: true });
  const outPath = join(ROOT, "data", "lbk.json");
  await writeFile(outPath, JSON.stringify(file, null, 2), "utf8");

  const withAppId = localizations.filter((l) => l.steamAppId).length;
  const withVoice = localizations.filter((l) => l.hasVoice).length;
  const inDev = localizations.filter((l) => l.inDevelopment).length;
  console.log(`[LBK] done → ${outPath}`);
  console.log(
    `[LBK] total=${localizations.length}, steam-appid=${withAppId}, with-voice=${withVoice}, in-dev=${inDev}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
