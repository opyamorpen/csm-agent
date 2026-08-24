#!/usr/bin/env bash
# Generate AppIcon.icns from assets/icon.svg using only macOS built-ins
# (qlmanage + sips + iconutil). No external dependencies.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SVG="$ROOT/assets/icon.svg"
OUT_ICNS="$ROOT/assets/AppIcon.icns"
WORK="$(mktemp -d /tmp/csm-icon.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

# 1. Render the SVG to a single large PNG (Quick Look thumbnail).
qlmanage -t -s 1024 -o "$WORK" "$SVG" >/dev/null 2>&1
SRC="$WORK/icon.svg.png"
[ -f "$SRC" ] || { echo "错误：SVG 渲染失败" >&2; exit 1; }

# 2. Build the .iconset with all required sizes.
ICONSET="$WORK/AppIcon.iconset"
mkdir -p "$ICONSET"
declare -a SIZES=(16 32 128 256 512)
for s in "${SIZES[@]}"; do
  d=$((s * 2))
  sips -z "$s" "$s" "$SRC" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z "$d" "$d" "$SRC" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done

# 3. Convert to .icns.
iconutil -c icns "$ICONSET" -o "$OUT_ICNS"
echo "✅ 已生成: $OUT_ICNS"
