#!/usr/bin/env bash
# Final clean re-generation of every source base.
#   1. snapshot each data/<name>.json -> data/<name>.json.backup
#   2. regen in dependency order (revoiceai -> playground -> synthvoiceru, rest after)
#   3. degradation guard: if a fresh base has < 50% of its backup's entries,
#      restore from the backup (a throttled run must not clobber good data)
set -u
cd "$(dirname "$0")"

BASES="gpp hernipreklady komunitni-preklady kuli lbk lokalizace magyaritasok mvo playground revoiceai synthvoiceru tribogamer turkce-yama calypsoceviri"
ORDER="revoiceai playground synthvoiceru gpp hernipreklady komunitni-preklady kuli lbk lokalizace magyaritasok mvo tribogamer turkce-yama calypsoceviri"

count() { node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).localizations.length)}catch{console.log(0)}' "$1" 2>/dev/null; }

echo "=== 1. snapshot -> .backup ==="
for b in $BASES; do
  [ -f "data/$b.json" ] && mv -f "data/$b.json" "data/$b.json.backup" && echo "  $b.json -> $b.json.backup ($(count "data/$b.json.backup"))"
done

echo "=== 2. regenerate ($ORDER) ==="
SUMMARY=""
for g in $ORDER; do
  echo ">>> $g ($(date +%H:%M:%S))"
  node "generators/$g.mjs" 2>&1 | tail -1
  new=$(count "data/$g.json"); bak=$(count "data/$g.json.backup")
  # degradation guard
  if [ "$bak" -gt 0 ] && [ "$new" -lt $((bak / 2)) ]; then
    echo "  !! $g degraded ($new < 50% of $bak) -> restoring backup"
    cp -f "data/$g.json.backup" "data/$g.json"
    SUMMARY="$SUMMARY\n  $g: $new (DEGRADED -> restored $bak)"
  else
    SUMMARY="$SUMMARY\n  $g: $new (backup $bak)"
  fi
done

echo "=== 3. итог (new / backup) ==="
echo -e "$SUMMARY"
echo "=== DONE $(date +%H:%M:%S) ==="
