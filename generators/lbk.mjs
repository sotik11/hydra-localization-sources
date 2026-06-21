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
 * The anon key below is the public client key (embedded in their launcher by
 * design); it only allows the same read access the launcher itself has.
 */
import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const SUPABASE = "https://supabase.lbklauncher.com";
const ANON =
  "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJzdXBhYmFzZSIsImlhdCI6MTc2NjYxOTk2MCwiZXhwIjo0OTIyMjkzNTYwLCJyb2xlIjoiYW5vbiJ9.RAF4fjT-EMflMgml9JVeUwUO8rSs4Wfr9MDWSG1tBUU";
const SITE = "https://lbklauncher.com";

const SOURCE_NAME = "LBK";
const LANGUAGE = "Українська";

async function fetchGames() {
  const url =
    `${SUPABASE}/rest/v1/games?select=name,slug,steam_app_id,team,status,` +
    `translation_progress,version,archive_path,voice_archive_path,updated_at` +
    `&approved=eq.true&hide=eq.false&order=name.asc&limit=2000`;
  const res = await fetch(url, {
    headers: { apikey: ANON, Authorization: `Bearer ${ANON}` },
  });
  if (!res.ok) throw new Error(`GET games -> ${res.status}`);
  return res.json();
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
    // LBK aggregates 350+ teams (some with long multi-author credits) — using
    // a single source name keeps cards clean; the team is on the game page.
    studio: SOURCE_NAME,
    studioUrl: SITE,
    language: LANGUAGE,
    hasText: Boolean(game.archive_path),
    hasVoice: Boolean(game.voice_archive_path),
    version: game.version ?? null,
    updatedAt: formatDate(game.updated_at),
    pageUrl,
    howToInstallHtml: HOW_TO_INSTALL,
    inDevelopment: (game.translation_progress ?? 100) < 100,
    // No mirrors — downloads are gated behind LBK's tracked Edge Function.
    mirrors: [],
  };
}

async function main() {
  console.log("[LBK] fetching games…");
  const games = (await fetchGames()).filter((g) => g.name);
  console.log(`[LBK] ${games.length} games`);

  const localizations = games.map(buildEntry);

  const file = { name: SOURCE_NAME, language: LANGUAGE, localizations };
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
