#!/usr/bin/env bash
# Local (residential-IP) refresh of the sources that GitHub's datacenter IPs can't
# reach. komunitni-preklady / magyaritasok / tribogamer block datacenter ranges
# (confirmed 2026-06-29: 0 from the runner, full counts from a home IP — and it's
# IP-level, not a TLS-fingerprint thing, so curl on CI doesn't help either). The
# cloud cron handles the other 11; this script is meant to run from a Windows
# Scheduled Task on a residential connection and push just these three.
#
# Same degradation guard as regen_all.sh: a throttled/blocked run never clobbers
# good data. All output is teed to refresh_local.log (gitignored) so runs can be
# inspected after the fact.
set -u
cd "$(dirname "$0")"

LOG="refresh_local.log"
exec > >(tee -a "$LOG") 2>&1

SOURCES="komunitni-preklady magyaritasok tribogamer"

echo ""
echo "######## refresh_local $(date '+%Y-%m-%d %H:%M:%S %z') ########"

# 1. Sync with the cloud cron's commits first, so the push at the end fast-forwards.
echo "=== 1. git pull --rebase ==="
if ! git pull --rebase origin main; then
  echo "  !! git pull --rebase failed (dirty tree or conflict) — aborting, will retry next run"
  git rebase --abort 2>/dev/null
  exit 1
fi

count() { node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).localizations.length)}catch{console.log(0)}' "$1" 2>/dev/null; }

# 2. snapshot -> regen -> degradation guard, for the three blocked sources.
echo "=== 2. regenerate ($SOURCES) ==="
SUMMARY=""
for g in $SOURCES; do
  [ -f "data/$g.json" ] && cp -f "data/$g.json" "data/$g.json.backup"
  echo ">>> $g ($(date +%H:%M:%S))"
  node "generators/$g.mjs" 2>&1 | tail -1
  new=$(count "data/$g.json"); bak=$(count "data/$g.json.backup")
  if [ "$bak" -gt 0 ] && [ "$new" -lt $((bak / 2)) ]; then
    echo "  !! $g degraded ($new < 50% of $bak) -> restoring backup"
    cp -f "data/$g.json.backup" "data/$g.json"
    SUMMARY="$SUMMARY\n  $g: $new (DEGRADED -> restored $bak)"
  else
    SUMMARY="$SUMMARY\n  $g: $new (backup $bak)"
  fi
done
echo "=== итог (new / backup) ==="
echo -e "$SUMMARY"

# 3. Commit & push only these three data files, only if something changed.
echo "=== 3. commit & push ==="
git add $(for g in $SOURCES; do echo "data/$g.json"; done)
if git diff --staged --quiet; then
  echo "  no data changes — nothing to commit"
else
  git commit -m "data: local refresh (komunitni-preklady / magyaritasok / tribogamer) [skip ci]" \
    && git push origin main \
    && echo "  pushed" || echo "  !! commit/push failed"
fi

echo "######## DONE $(date '+%Y-%m-%d %H:%M:%S') ########"
