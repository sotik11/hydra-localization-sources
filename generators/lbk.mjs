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
 * API access (public anon key + recovery when LBK rotates it) lives in
 * lib/lbk-api.mjs, shared with the weekly channel check.
 */
import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SITE, lbkGames } from "../lib/lbk-api.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const SOURCE_NAME = "LBK";
const LANGUAGE = "Українська";

// hide=eq.false: hidden entries are code-gated translations (the launcher shows
// them only after the user unlocks one with a code) and have no public page.
const GAMES_QUERY =
  "select=name,slug,steam_app_id,team,status,translation_progress,version," +
  "archive_path,voice_archive_path,updated_at,translation_updated_at" +
  "&approved=eq.true&hide=eq.false&order=name.asc&limit=2000";

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
  const games = (await lbkGames(GAMES_QUERY)).filter((g) => g.name);
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
