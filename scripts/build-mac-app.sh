#!/usr/bin/env bash
# Build a native macOS .app bundle: a Swift WKWebView shell that launches the
# Node server (dist/index.js) in the background and shows the web UI in a window.
#
# Prereqs: Xcode Command Line Tools (for swiftc) and Node.js. No Rust/Electron.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="CSM Agent"
EXEC_NAME="CSMAgent"
BUILD_DIR="$ROOT/.build-mac"
APP_DIR="$ROOT/dist-mac/$APP_NAME.app"
CSM_PORT="${CSM_PORT:-3210}"
APP_VERSION="$(node -p "require('$ROOT/package.json').version")"

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "错误：找不到 node。请先安装 Node.js（>=20）。" >&2
  exit 1
fi
NPX_DIR=""
if NPX_BIN="$(command -v npx 2>/dev/null)"; then
  NPX_DIR="$(dirname "$NPX_BIN")"
fi

echo "==> 构建服务器 dist/"
(cd "$ROOT" && npm run build)

echo "==> 准备 .app 包结构"
rm -rf "$APP_DIR" "$BUILD_DIR"
mkdir -p "$APP_DIR/Contents/MacOS" "$APP_DIR/Contents/Resources" "$BUILD_DIR"
sed "s/<string>0\.1\.0<\/string>/<string>$APP_VERSION<\/string>/g" "$ROOT/scripts/mac-app/Info.plist" > "$APP_DIR/Contents/Info.plist"

echo "==> 生成应用图标（AppIcon.icns）"
if [ ! -f "$ROOT/assets/AppIcon.icns" ] || [ "$ROOT/assets/icon.svg" -nt "$ROOT/assets/AppIcon.icns" ]; then
  "$ROOT/scripts/build-icon.sh" >/dev/null
fi
cp "$ROOT/assets/AppIcon.icns" "$APP_DIR/Contents/Resources/AppIcon.icns"

echo "==> 生成 main.swift（写入 node 路径、npx 目录、项目路径与服务端口）"
python3 - "$ROOT/scripts/mac-app/main.swift" "$BUILD_DIR/main.swift" "$NODE_BIN" "$ROOT" "$NPX_DIR" "$CSM_PORT" <<'PY'
import sys
src, dst, node_bin, repo, npx_dir, port = sys.argv[1:7]
with open(src, encoding='utf-8') as f:
    t = f.read()
t = t.replace('__NODE_BIN__', node_bin).replace('__REPO_DIR__', repo).replace('__NPX_DIR__', npx_dir).replace('__CSM_PORT__', port)
with open(dst, 'w', encoding='utf-8') as f:
    f.write(t)
PY

echo "==> 编译 Swift 壳"
mkdir -p "$BUILD_DIR/swift-module-cache"
swiftc -O \
  -module-cache-path "$BUILD_DIR/swift-module-cache" \
  -sdk-module-cache-path "$BUILD_DIR/swift-module-cache" \
  "$BUILD_DIR/main.swift" \
  -o "$APP_DIR/Contents/MacOS/$EXEC_NAME"

echo "==> 临时签名（个人使用；正式分发需 Developer ID 签名 + 公证）"
codesign --force --deep -s - "$APP_DIR" 2>/dev/null || echo "（跳过签名）"

echo ""
echo "✅ 已生成: $APP_DIR"
echo "运行方式: open \"$APP_DIR\""
echo "（如 Gatekeeper 拦截，右键 → 打开；或执行 xattr -dr com.apple.quarantine \"$APP_DIR\"）"
