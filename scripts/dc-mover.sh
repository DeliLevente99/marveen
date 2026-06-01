#!/bin/bash
# dc-mover -- a vendorolt (patchelt) Discord plugin server.ts ráhúzása a
# telepített pluginra.
#
# Miért kell: a discord-plugin-patcher.ts boot közben felülírja a
# telepített plugint a vendor/discord-plugin/server.ts-szel, DE
# idempotens: ha a PATCH_MARKER string már benne van a telepített
# fájlban, kihagyja az újraírást. Így ha a vendored server.ts változik
# (pl. egy gate-fix), a már-egyszer-patchelt telepített plugin a RÉGI
# kódnál ragad a következő boot-ban is. Ez a script megkerüli ezt:
# feltétel nélkül átmásolja a friss vendored fájlt.
#
# Verzió-detektálás: a telepített plugin egy alkönyvtárt rak le verziónként
# (pl. 0.0.4/). A legmagasabb verziójú alkönyvtárat választjuk -- ugyanaz a
# logika, mint a patcher-ben.
#
# Használat:
#   ./scripts/dc-mover.sh          # másol + ellenőriz
#   ./scripts/dc-mover.sh --check  # csak ellenőriz, nem ír (diff)
#
# Kilépési kód: 0 = kész/egyezik, 1 = hiba (nincs plugin / nincs vendored).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VENDORED="$REPO_ROOT/vendor/discord-plugin/server.ts"
PLUGIN_BASE="$HOME/.claude/plugins/cache/claude-plugins-official/discord"

CHECK_ONLY=false
[ "${1:-}" = "--check" ] && CHECK_ONLY=true

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; DIM='\033[2m'; NC='\033[0m'

if [ ! -f "$VENDORED" ]; then
  echo -e "${RED}✗${NC} Nincs vendorolt fájl: $VENDORED"
  exit 1
fi

if [ ! -d "$PLUGIN_BASE" ]; then
  echo -e "${RED}✗${NC} A Discord plugin nincs telepítve: $PLUGIN_BASE"
  echo -e "  ${DIM}Telepítsd: claude plugin install discord@claude-plugins-official${NC}"
  exit 1
fi

# Legmagasabb verziójú alkönyvtár (X.Y.Z formátum), mint a patcher-ben.
INSTALLED_VERSION="$(find "$PLUGIN_BASE" -maxdepth 1 -mindepth 1 -type d -printf '%f\n' 2>/dev/null \
  | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1)"

if [ -z "$INSTALLED_VERSION" ]; then
  echo -e "${RED}✗${NC} Nem találok verziózott plugin alkönyvtárat itt: $PLUGIN_BASE"
  exit 1
fi

TARGET="$PLUGIN_BASE/$INSTALLED_VERSION/server.ts"
if [ ! -f "$TARGET" ]; then
  echo -e "${RED}✗${NC} A telepített server.ts nem létezik: $TARGET"
  exit 1
fi

echo -e "${DIM}vendored: $VENDORED${NC}"
echo -e "${DIM}telepített ($INSTALLED_VERSION): $TARGET${NC}"

if cmp -s "$VENDORED" "$TARGET"; then
  echo -e "${GREEN}✓${NC} Már azonos, nincs teendő."
  exit 0
fi

if $CHECK_ONLY; then
  echo -e "${YELLOW}!${NC} Eltér. Diff (telepített -> vendored):"
  diff "$TARGET" "$VENDORED" || true
  echo -e "  ${DIM}Másoláshoz futtasd argumentum nélkül: ./scripts/dc-mover.sh${NC}"
  exit 0
fi

# Eredeti fájlmód megőrzése (a patcher is ezt teszi -- az npm-shim chmod
# után más mode-bit lehet beállítva).
ORIG_MODE="$(stat -c '%a' "$TARGET" 2>/dev/null || echo '')"
cp "$VENDORED" "$TARGET"
[ -n "$ORIG_MODE" ] && chmod "$ORIG_MODE" "$TARGET"

echo -e "${GREEN}✓${NC} Átmásolva. A futó channels-session újraindítása kell, hogy érvényre jusson."
