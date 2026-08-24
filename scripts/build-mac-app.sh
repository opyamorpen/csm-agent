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

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "错误：找不到 node。请先安装 Node.js（>=20）。" >&2
  exit 1
fi

echo "==> 构建服务器 dist/"
(cd "$ROOT" && npm run build)

echo "==> 准备 .app 包结构"
rm -rf "$APP_DIR" "$BUILD_DIR"
mkdir -p "$APP_DIR/Contents/MacOS" "$APP_DIR/Contents/Resources" "$BUILD_DIR"
cp "$ROOT/scripts/mac-app/Info.plist" "$APP_DIR/Contents/Info.plist"

echo "==> 生成应用图标（AppIcon.icns）"
if [ ! -f "$ROOT/assets/AppIcon.icns" ]; then
  "$ROOT/scripts/build-icon.sh" >/dev/null
fi
cp "$ROOT/assets/AppIcon.icns" "$APP_DIR/Contents/Resources/AppIcon.icns"

echo "==> 生成 main.swift（写入 node 路径与项目路径）"
python3 - "$ROOT/scripts/mac-app/main.swift" "$BUILD_DIR/main.swift" "$NODE_BIN" "$ROOT" <<'PY'
import sys
src, dst, node_bin, repo = sys.argv[1:5]
with open(src, encoding='utf-8') as f:
    t = f.read()
t = t.replace('__NODE_BIN__', node_bin).replace('__REPO_DIR__', repo)
with open(dst, 'w', encoding='utf-8') as f:
    f.write(t)
PY

echo "==> 编译 Swift 壳"
swiftc -O "$BUILD_DIR/main.swift" -o "$APP_DIR/Contents/MacOS/$EXEC_NAME"

echo "==> 临时签名（个人使用；正式分发需 Developer ID 签名 + 公证）"
codesign --force --deep -s - "$APP_DIR" 2>/dev/null || echo "（跳过签名）"

echo ""
echo "✅ 已生成: $APP_DIR"
echo "运行方式: open \"$APP_DIR\""
echo "（如 Gatekeeper 拦截，右键 → 打开；或执行 xattr -dr com.apple.quarantine \"$APP_DIR\"）"
