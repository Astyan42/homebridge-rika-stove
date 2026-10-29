#!/bin/bash
# Rapatrie les journaux de mesures du poêle depuis le Raspberry vers OneDrive,
# où ils deviennent consultables depuis le Mac, l'iPhone et le web.
#
# Installé comme agent launchd : ~/Library/LaunchAgents/fr.jyam.poele-mesures.plist

set -u

PI="jd@192.168.1.32"
CLE="$HOME/.ssh/id_homebridge"
SOURCE="/var/lib/homebridge/mesures/"
DEST="$HOME/Library/CloudStorage/OneDrive-Jyam/HomeKit/poele"
JOURNAL="$DEST/.sync.log"

mkdir -p "$DEST"

if ! ssh -i "$CLE" -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=10 \
     "$PI" 'exit' 2>/dev/null; then
  echo "$(date '+%Y-%m-%d %H:%M:%S')  Raspberry injoignable, rien à faire" >> "$JOURNAL"
  exit 0
fi

rsync -az --timeout=60 \
  -e "ssh -i $CLE -o BatchMode=yes -o IdentitiesOnly=yes" \
  "$PI:$SOURCE" "$DEST/" 2>>"$JOURNAL"

CODE=$?
N=$(ls -1 "$DEST"/poele-*.csv 2>/dev/null | wc -l | tr -d ' ')
L=$(cat "$DEST"/poele-*.csv 2>/dev/null | wc -l | tr -d ' ')
echo "$(date '+%Y-%m-%d %H:%M:%S')  rsync=$CODE  fichiers=$N  lignes=$L" >> "$JOURNAL"

# Le journal de synchronisation ne doit pas grossir indéfiniment.
if [ "$(wc -l < "$JOURNAL" 2>/dev/null || echo 0)" -gt 500 ]; then
  tail -200 "$JOURNAL" > "$JOURNAL.tmp" && mv "$JOURNAL.tmp" "$JOURNAL"
fi
exit 0
