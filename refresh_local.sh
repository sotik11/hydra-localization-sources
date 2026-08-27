#!/usr/bin/env bash
# Local (residential-IP) refresh of the sources that GitHub's datacenter IPs can't
# reach. komunitni-preklady / magyaritasok / tribogamer block datacenter ranges
# (confirmed 2026-06-29: 0 from the runner, full counts from a home IP — and it's
# IP-level, not a TLS-fingerprint thing, so curl on CI doesn't help either). The
# cloud cron handles the other 11; this script is meant to run from a Windows
# Scheduled Task on a residential connection and push just these three.
#
# Same degradation guard as regen_all.sh: a throttled/blocked run never clobbers
# good data. All output is teed to refresh_local.log (gitignored). Start/finish are
# announced as Windows toasts via notify.ps1 (best-effort — never fail the refresh).
set -u
cd "$(dirname "$0")"

DIR="$(pwd)"
LOG="refresh_local.log"
exec > >(tee -a "$LOG") 2>&1

PS_NOTIFY="$(cygpath -w "$DIR/notify.ps1" 2>/dev/null || echo "")"
notify() { # $1=title $2=message — best-effort, must never abort the run
  [ -n "$PS_NOTIFY" ] && powershell.exe -NoProfile -ExecutionPolicy Bypass \
    -File "$PS_NOTIFY" -Title "$1" -Message "$2" >/dev/null 2>&1
  return 0
}

# Telegram — final result only (like the cloud regenerate.yml), best-effort,
# never aborts the run. Creds live in a shared, gitignored file outside any repo;
# if they are empty/absent, tg() is a silent no-op.
[ -f "/c/temp/claude/.telegram.env" ] && . "/c/temp/claude/.telegram.env"
NL=$'\n'
tg() { # $1 = HTML text — piped via stdin (text@-) on purpose: MSYS mangles
       # non-ASCII bytes in a command-line arg, so inline --data-urlencode
       # "text=…" reaches Telegram as invalid UTF-8; stdin preserves raw bytes.
  [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ] || return 0
  printf '%s' "$1" | curl -s -m 15 -X POST \
    "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
    --data-urlencode "parse_mode=HTML" \
    --data-urlencode "disable_web_page_preview=true" \
    --data-urlencode "text@-" >/dev/null 2>&1
  return 0
}

SOURCES="komunitni-preklady magyaritasok tribogamer"

echo ""
echo "######## refresh_local $(date '+%Y-%m-%d %H:%M:%S %z') ########"
notify "Hydra refresh — старт" "Обновляю: komunitni-preklady, magyaritasok, tribogamer…"

# 1. Sync with the cloud cron's commits first, so the push at the end fast-forwards.
# Everything happens on `stable`: that is the live feed the Hydra clients read.
# `main` is the failsafe snapshot, written only by failsafe-snapshot.yml.
echo "=== 1. git checkout stable + pull --rebase ==="
if ! git checkout stable; then
  echo "  !! git checkout stable failed (dirty tree?) — aborting, will retry next run"
  notify "Hydra refresh — ОШИБКА" "git checkout stable не прошёл (грязное дерево). Повтор в следующий запуск."
  tg $'⚠️ <b>Локализации (локально)</b>\ngit checkout stable не прошёл — повтор в следующий запуск.'
  exit 1
fi
if ! git pull --rebase --autostash origin stable; then
  echo "  !! git pull --rebase failed (dirty tree or conflict) — aborting, will retry next run"
  git rebase --abort 2>/dev/null
  notify "Hydra refresh — ОШИБКА" "git pull --rebase не прошёл (конфликт/грязное дерево). Повтор в следующий запуск."
  tg $'⚠️ <b>Локализации (локально)</b>\ngit pull --rebase не прошёл — повтор в следующий запуск.'
  exit 1
fi

count() { node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).localizations.length)}catch{console.log(0)}' "$1" 2>/dev/null; }

# 2. snapshot -> regen -> degradation guard, for the three blocked sources.
echo "=== 2. regenerate ($SOURCES) ==="
SUMMARY=""
TOAST=""
TG=""       # Telegram body: one source per line, "<u>name</u> — +N (was → now)"
SEP=""
for g in $SOURCES; do
  [ -f "data/$g.json" ] && cp -f "data/$g.json" "data/$g.json.backup"
  echo ">>> $g ($(date +%H:%M:%S))"
  node "generators/$g.mjs" 2>&1 | tail -1
  new=$(count "data/$g.json"); bak=$(count "data/$g.json.backup")
  if [ "$bak" -gt 0 ] && [ "$new" -lt $((bak / 2)) ]; then
    echo "  !! $g degraded ($new < 50% of $bak) -> restoring backup"
    cp -f "data/$g.json.backup" "data/$g.json"
    SUMMARY="$SUMMARY\n  $g: $new (DEGRADED -> restored $bak)"
    TOAST="$TOAST$SEP$g: $bak (откат!)"
    TG="${TG:+$TG$NL}<u>$g</u> — обвал ($new), откат к $bak"
  else
    delta=$((new - bak)); sign=$([ "$delta" -ge 0 ] && echo "+")
    SUMMARY="$SUMMARY\n  $g: $new (backup $bak)"
    TOAST="$TOAST$SEP$g: $new"
    TG="${TG:+$TG$NL}<u>$g</u> — ${sign}${delta} ($bak → $new)"
  fi
  SEP=" · "
done
echo "=== итог (new / backup) ==="
echo -e "$SUMMARY"

# 3. Commit & push only these three data files, only if something changed.
echo "=== 3. commit & push ==="
git add $(for g in $SOURCES; do echo "data/$g.json"; done)
if git diff --staged --quiet; then
  echo "  no data changes — nothing to commit"
  STATUS="без изменений"
else
  if git commit -m "data: local refresh (komunitni-preklady / magyaritasok / tribogamer) [skip ci]" && git push origin HEAD:stable; then
    echo "  pushed"
    STATUS="запушено ✓"
  else
    echo "  !! commit/push failed"
    STATUS="ошибка push ✗"
  fi
fi

echo "######## DONE $(date '+%Y-%m-%d %H:%M:%S') ########"
notify "Hydra refresh — готово ($STATUS)" "$TOAST"
tg "$(printf '✅ <b>Локализации (локально)</b> — %s\n\n%s' "$STATUS" "$TG")"
