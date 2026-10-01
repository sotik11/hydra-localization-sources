/**
 * Weekly reconciliation: LBK's Telegram channel vs our data/lbk.json.
 *
 * LBK announces every new translation in t.me/LittleBitUA with the header
 * "Зустрічайте новий переклад у LBK Launcher!" and a link to
 * lbklauncher.com/games/<slug> — the same url we store as `pageUrl`. So the
 * check needs no title matching: every announced slug must be in the feed.
 *
 * It is a second safety net behind the "restored source" warning of
 * regenerate.yml: that one catches a generator that crashes, this one catches a
 * generator that runs fine but returns less than LBK has published (the feed
 * once stood still for two months while 75 translations were announced).
 *
 * The public web preview (t.me/s/<channel>) is read — no bot, no account.
 *
 * An announced slug missing from the feed is sorted into:
 *   - gated    hide=true: a code-locked translation, deliberately not in the feed
 *   - removed  gone from LBK's database (their page answers 410/404)
 *   - MISSING  approved and visible at LBK, absent from our feed  -> the alarm
 *
 * Prints a Telegram-HTML report to stdout. Exit code: 0 all good, 3 attention
 * needed (something MISSING, or the channel could not be read).
 *
 * Usage: node lbk-channel-check.mjs [--days 14] [--feed data/lbk.json]
 */
import { readFileSync } from "node:fs";
import { fetchTimeout, getText, sleep, UA } from "../../lib/net.mjs";
import { SITE, lbkGames } from "../../lib/lbk-api.mjs";

const CHANNEL = "LittleBitUA";
const MARK = "Зустрічайте новий переклад";
const MAX_PAGES = 60;

const argOf = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const DAYS = Number(argOf("--days", "14")) || 14;
const FEED = argOf("--feed", "data/lbk.json");
const since = new Date(Date.now() - DAYS * 86400e3).toISOString().slice(0, 10);

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const dm = (iso) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;

/** slug -> ISO date of the announcement, for posts dated `since` or later. */
async function readAnnouncements() {
  const found = new Map();
  let before = null;
  let oldest = "9999";
  let postsSeen = 0;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const html = await getText(`https://t.me/s/${CHANNEL}` + (before ? `?before=${before}` : ""), { ms: 20000 });
    const posts = html.split(/(?=<div class="tgme_widget_message_wrap)/).slice(1);
    if (!posts.length) break;
    postsSeen += posts.length;
    let minId = Infinity;
    for (const post of posts) {
      const id = Number((post.match(/data-post="[^"/]+\/(\d+)"/) || [])[1]);
      const date = ((post.match(/datetime="([^"]+)"/) || [])[1] || "").slice(0, 10);
      if (id) minId = Math.min(minId, id);
      if (date && date < oldest) oldest = date;
      if (!post.includes(MARK) || date < since) continue;
      for (const m of post.matchAll(/href="https?:\/\/(?:www\.)?lbklauncher\.com\/games\/([^"/?#]+)/g)) {
        if (!found.has(m[1])) found.set(m[1], date);
      }
    }
    if (oldest < since || !Number.isFinite(minId)) break;
    before = minId;
    await sleep(700);
  }
  return { found, postsSeen, oldest };
}

async function pageStatus(slug) {
  try {
    const res = await fetchTimeout(`${SITE}/games/${slug}`, { headers: { "User-Agent": UA } }, 15000);
    return res.status;
  } catch {
    return 0;
  }
}

async function main() {
  const { found, postsSeen, oldest } = await readAnnouncements();

  // An empty read is a failure of the check itself (preview layout changed,
  // channel renamed, t.me unreachable) — never "nothing was announced".
  if (!postsSeen || oldest > since) {
    console.log(
      `⚠️ <b>LBK — сверка с каналом не удалась</b>\n\n` +
        `Не удалось прочитать превью <code>t.me/s/${CHANNEL}</code> на ${DAYS} дн. назад ` +
        `(постов: ${postsSeen}, самый старый: ${esc(oldest)}).`
    );
    process.exit(3);
  }

  const feed = JSON.parse(readFileSync(FEED, "utf8")).localizations;
  const inFeed = new Set(feed.map((l) => (l.pageUrl || "").split("/games/")[1]).filter(Boolean));
  const absent = [...found].filter(([slug]) => !inFeed.has(slug));

  const gated = [];
  const removed = [];
  const missing = [];
  if (absent.length) {
    const slugs = absent.map(([slug]) => slug).join(",");
    const rows = await lbkGames(`select=name,slug,approved,hide&slug=in.(${slugs})`);
    const bySlug = new Map(rows.map((r) => [r.slug, r]));
    for (const [slug, date] of absent) {
      const row = bySlug.get(slug);
      const item = { slug, date, name: row?.name || slug };
      if (row?.hide) gated.push(item);
      else if (row && row.approved) missing.push({ ...item, why: "есть у LBK, нет в фиде" });
      else if (row) removed.push({ ...item, why: "снят с публикации" });
      else {
        const status = await pageStatus(slug);
        if (status === 410 || status === 404) removed.push({ ...item, why: `страница ${status}` });
        else missing.push({ ...item, why: `нет в базе LBK, страница ${status || "недоступна"}` });
      }
    }
  }

  const list = (items) => items.map((i) => `<u>${esc(i.name)}</u> (${dm(i.date)})`).join(", ");
  const lines = [
    `${missing.length ? "⚠️" : "✅"} <b>LBK — сверка с каналом</b>`,
    "",
    `Анонсов за ${DAYS} дн.: <b>${found.size}</b>, в фиде: <b>${found.size - absent.length}</b>`,
  ];
  if (gated.length) lines.push(`• скрыты по коду: ${list(gated)}`);
  if (removed.length) lines.push(`• удалены у LBK: ${list(removed)}`);
  if (missing.length) {
    lines.push("", "⚠️ <b>Нет в фиде:</b>");
    for (const i of missing) lines.push(`• <u>${esc(i.name)}</u> — анонс ${dm(i.date)}, ${esc(i.why)}`);
  }
  console.log(lines.join("\n"));
  process.exit(missing.length ? 3 : 0);
}

main().catch((err) => {
  console.log(`⚠️ <b>LBK — сверка с каналом упала</b>\n\n<code>${esc(err.message).slice(0, 300)}</code>`);
  process.exit(3);
});
