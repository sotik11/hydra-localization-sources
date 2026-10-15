#!/usr/bin/env bash
# Final clean re-generation of every source base.
#   1. snapshot each data/<name>.json -> data/<name>.json.backup
#   2. regen in dependency order (revoiceai -> playground -> synthvoiceru, rest after)
#   3. degradation guard: if a generator fails, or a fresh base lost more than
#      MAX_DROP_PCT of its backup's entries, restore from the backup (a crashed
#      or throttled run must not clobber good data)
#   4. every restored source is written to $REGEN_FAILED_FILE as "name|reason",
#      so the notification can say so. A restored source has the same count as
#      before and used to be reported as "no changes" — that is how a generator
#      that crashed every day (LBK, rotated API key) went unnoticed for 2 months.
set -u
cd "$(dirname "$0")"

MAX_DROP_PCT=15
# Pause before the single rerun of a generator that exited non-zero.
RETRY_PAUSE="${RETRY_PAUSE:-120}"
REGEN_FAILED_FILE="${REGEN_FAILED_FILE:-/tmp/regen-failed.txt}"
: > "$REGEN_FAILED_FILE"
GEN_LOG="$(mktemp 2>/dev/null || echo /tmp/regen-gen.log)"

BASES="gpp hernipreklady komunitni-preklady kuli lbk lokalizace magyaritasok mvo playground revoiceai synthvoiceru tribogamer turkce-yama calypsoceviri"
ORDER="revoiceai playground synthvoiceru gpp hernipreklady komunitni-preklady kuli lbk lokalizace magyaritasok mvo tribogamer turkce-yama calypsoceviri"

# Optional skip-list (space-separated). CI sets SKIP_SOURCES to the sources whose
# sites block GitHub's datacenter IPs (komunitni-preklady / magyaritasok / tribogamer);
# those are refreshed locally from a residential IP instead (see refresh_local.sh).
# Empty by default => run everything (so a local full run still covers all 14).
SKIP_SOURCES="${SKIP_SOURCES:-}"
filter() {
  out=""
  for x in $1; do
    case " $SKIP_SOURCES " in *" $x "*) continue ;; esac
    out="$out $x"
  done
  echo "$out"
}
if [ -n "$SKIP_SOURCES" ]; then
  BASES="$(filter "$BASES")"
  ORDER="$(filter "$ORDER")"
  echo "=== SKIP_SOURCES: $SKIP_SOURCES — пропускаю (обновляются локально) ==="
fi

count() { node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).localizations.length)}catch{console.log(0)}' "$1" 2>/dev/null; }

echo "=== 1. snapshot -> .backup ==="
for b in $BASES; do
  [ -f "data/$b.json" ] && mv -f "data/$b.json" "data/$b.json.backup" && echo "  $b.json -> $b.json.backup ($(count "data/$b.json.backup"))"
done

echo "=== 2. regenerate ($ORDER) ==="
SUMMARY=""
for g in $ORDER; do
  echo ">>> $g ($(date +%H:%M:%S))"
  node "generators/$g.mjs" > "$GEN_LOG" 2>&1
  rc=$?
  if [ "$rc" -ne 0 ]; then
    # One patient retry: a site that is down for a minute must not cost the day.
    echo "  !! $g exited $rc — retrying once in ${RETRY_PAUSE}s; first failure:"
    tail -4 "$GEN_LOG" | sed 's/^/     /'
    sleep "$RETRY_PAUSE"
    node "generators/$g.mjs" > "$GEN_LOG" 2>&1
    rc=$?
  fi
  tail -1 "$GEN_LOG"
  new=$(count "data/$g.json"); bak=$(count "data/$g.json.backup")
  floor=$(( bak * (100 - MAX_DROP_PCT) / 100 ))

  why=""
  if [ "$rc" -ne 0 ]; then
    why="генератор упал (код $rc)"
    # the real error is above the last line — show it instead of swallowing it
    echo "  !! $g exited $rc — last lines:"; tail -15 "$GEN_LOG" | sed 's/^/     /'
  elif [ "$bak" -gt 0 ] && [ "$new" -lt "$floor" ]; then
    why="обвал ($bak → $new)"
    echo "  !! $g degraded ($new < $floor = -${MAX_DROP_PCT}% of $bak)"
  fi

  if [ -n "$why" ]; then
    if [ -f "data/$g.json.backup" ]; then
      echo "  -> restoring backup ($bak)"
      cp -f "data/$g.json.backup" "data/$g.json"
    fi
    echo "$g|$why" >> "$REGEN_FAILED_FILE"
    SUMMARY="$SUMMARY\n  $g: $new (FAILED: $why -> restored $bak)"
  else
    SUMMARY="$SUMMARY\n  $g: $new (backup $bak)"
  fi
done

echo "=== 3. итог (new / backup) ==="
echo -e "$SUMMARY"
echo "=== DONE $(date +%H:%M:%S) ==="
