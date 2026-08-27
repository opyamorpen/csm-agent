#!/usr/bin/env bash
# CSM Agent 一键安装 / 更新（macOS）。
#
#   curl -fsSL https://raw.githubusercontent.com/opyamorpen/csm-agent/main/scripts/install.sh | bash
#
# 安装布局（用户数据与代码分离，更新/卸载不触碰数据）:
#   ~/.csm-agent/app                      受管代码目录（git clone）
#   ~/.csm-agent/node                     捆绑 Node 22 LTS（仅当系统 node <22.5）
#   ~/.local/bin/csm-agent                CLI shim
#   /Applications/CSM Agent.app           → app/dist-mac/ 符号链接
#   ~/Library/LaunchAgents/cn.csm-agent.service.plist   常驻服务（--no-service 跳过）
#   ~/.csm-agent/{config,sessions,*.sqlite,logs}        用户数据，永不触碰
#
# 已安装时重跑本脚本 = 更新（git fetch + reset --hard origin/main + 重建）。
# 隔离验收: bash scripts/install.sh --dir <dir> --bin-dir <dir> --data-dir <dir> --apps-dir <dir> --port <p> --no-service
set -euo pipefail

REPO_URL="https://github.com/opyamorpen/csm-agent.git"
BRANCH="main"
NODE_VERSION="22.23.2"
APP_NAME="CSM Agent"

arg_dir=""
arg_bin_dir=""
arg_data_dir=""
arg_apps_dir=""
arg_port=""
arg_no_service=false
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) arg_dir="$2"; shift 2 ;;
    --bin-dir) arg_bin_dir="$2"; shift 2 ;;
    --data-dir) arg_data_dir="$2"; shift 2 ;;
    --apps-dir) arg_apps_dir="$2"; shift 2 ;;
    --port) arg_port="$2"; shift 2 ;;
    --no-service) arg_no_service=true; shift ;;
    *) echo "未知参数: $1（支持 --dir/--bin-dir/--data-dir/--apps-dir/--port/--no-service）" >&2; exit 2 ;;
  esac
done

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m错误:\033[0m %s\n' "$*" >&2; exit 1; }

command -v git >/dev/null 2>&1 || die "缺少 git。请先安装 Xcode Command Line Tools: xcode-select --install 后重试"
[ "$(uname -s)" = "Darwin" ] || die "install.sh 目前只支持 macOS"

DATA_DIR="${arg_data_dir:-$HOME/.csm-agent}"
APP_DIR="${arg_dir:-$DATA_DIR/app}"
BIN_DIR="${arg_bin_dir:-$HOME/.local/bin}"
APPS_DIR="${arg_apps_dir:-/Applications}"
PORT="${arg_port:-3210}"
export CSM_DATA_DIR="$DATA_DIR"
[ -n "$arg_apps_dir" ] || APPS_WRITABLE_CHECK=1

# ---------------------------------------------------------------------------
say "安装目录: ${APP_DIR}（数据目录 ${DATA_DIR}）"

# ---------------------------------------------------------------------------
# Node 运行时: 系统 node >=22.5 可用则复用，否则下载捆绑 Node 到 $DATA_DIR/node
install_node() {
  local sys_version
  sys_version="$(node --version 2>/dev/null | sed 's/^v//' || true)"
  if [ -n "$sys_version" ]; then
    local major minor
    major="${sys_version%%.*}"
    minor="${sys_version#*.}"; minor="${minor%%.*}"
    if [ "$major" -gt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -ge 5 ]; }; then
      NODE_BIN="$(command -v node)"
      NODE_DIR_BINDN=  # 复用系统 Node
      say "使用系统 Node $sys_version"
      return
    fi
  fi
  local node_root="$DATA_DIR/node"
  local node_bin="$node_root/bin/node"
  if [ -x "$node_bin" ] && "$node_bin" --version | grep -q "v${NODE_VERSION%%.*}"; then
    say "复用已下载的捆绑 Node $("$node_bin" --version)"
    NODE_BIN="$node_bin"
    NODE_DIR_BINDN="$node_root/bin"
    return
  fi
  local arch
  arch="$(uname -m)"
  [ "$arch" = "arm64" ] || [ "$arch" = "x86_64" ] || die "不支持的 CPU 架构: $arch"
  local tarball="node-v${NODE_VERSION}-darwin-${arch}.tar.gz"
  say "下载 Node v${NODE_VERSION}（${arch}）到 $node_root"
  rm -rf "$node_root" "$node_root.tmp"
  mkdir -p "$node_root.tmp"
  curl -fsSL --retry 3 -o "$node_root.tmp/$tarball" "https://nodejs.org/dist/v${NODE_VERSION}/$tarball" \
    || die "下载 Node 失败，请检查网络后重试"
  tar -xzf "$node_root.tmp/$tarball" -C "$node_root.tmp"
  mv "$node_root.tmp/node-v${NODE_VERSION}-darwin-${arch}" "$node_root"
  rm -rf "$node_root.tmp"
  NODE_BIN="$node_bin"
  NODE_DIR_BINDN="$node_root/bin"
  say "捆绑 Node 就绪: $("$node_bin" --version)"
}

install_node
NODE_BIN_ABS="$(cd "$(dirname "$NODE_BIN")" && pwd)/$(basename "$NODE_BIN")"
if [ -n "${NODE_DIR_BINDN:-}" ]; then
  export PATH="$NODE_DIR_BINDN:$PATH"
  NPM_BIN="$NODE_DIR_BINDN/npm"
else
  NPM_BIN="$(command -v npm)"
fi
"$NODE_BIN" --version >/dev/null || die "Node 不可用"

# ---------------------------------------------------------------------------
write_layout() {
  local node_json="null"
  if [ -n "${NODE_DIR_BINDN:-}" ]; then
    node_json="\"$(dirname "$NODE_DIR_BINDN")\""
  fi
  cat > "$APP_DIR/.install-layout.json" <<EOF
{
  "method": "install.sh",
  "appDir": "$APP_DIR",
  "binDir": "$BIN_DIR",
  "appsDir": "$APPS_DIR",
  "port": $PORT,
  "branch": "$BRANCH",
  "nodeDir": $node_json,
  "service": $([ "$arg_no_service" = true ] && echo false || echo true)
}
EOF
  echo "install.sh" > "$APP_DIR/.install_method"
}

# ---------------------------------------------------------------------------
clone_or_update() {
  if [ -e "$APP_DIR/.install_method" ]; then
    say "检测到已有安装，走更新路径"
    (cd "$APP_DIR" \
      && git fetch origin "$BRANCH" \
      && git reset --hard "origin/$BRANCH" \
      && git clean -fdq -- dist dist-mac .build-mac)
    return
  fi
  if [ -e "$APP_DIR" ]; then
    die "$APP_DIR 已存在但不是受管安装（缺 .install_method）；请先移走该目录或换 --dir"
  fi
  say "克隆仓库到 $APP_DIR"
  git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
}

clone_or_update
write_layout

# ---------------------------------------------------------------------------
say "安装依赖并构建（npm ci）"
( cd "$APP_DIR" && "$NPM_BIN" ci )
( cd "$APP_DIR" && "$NPM_BIN" run build )

# ---------------------------------------------------------------------------
# CLI shim
mkdir -p "$BIN_DIR"
SHIM="$BIN_DIR/csm-agent"
if [ -e "$SHIM" ] || [ -L "$SHIM" ]; then
  if [ -L "$SHIM" ]; then
    say "移除旧的符号链接 shim（npm link 残留）"
    rm -f "$SHIM"
  elif grep -q "# csm-agent managed shim" "$SHIM" 2>/dev/null; then
    say "覆盖旧的受管 shim"
  else
    die "$SHIM 已存在且不是本安装器的 shim，请先处理（mv $SHIM $SHIM.bak）后重试"
  fi
fi
cat > "$SHIM" <<EOF
#!/usr/bin/env bash
# csm-agent managed shim — 由 scripts/install.sh 生成
exec "$NODE_BIN_ABS" "$APP_DIR/dist/cli.js" "\$@"
EOF
chmod +x "$SHIM"
say "CLI shim 就绪: $SHIM"

# PATH: ~/.local/bin 不在 PATH 时追加到 shell rc
case ":$PATH:" in
  *":$BIN_DIR:"*) : ;;
  *)
    RC_FILE="$HOME/.zshrc"
    [ -n "${ZSH_VERSION:-}" ] || RC_FILE="$HOME/.zshrc"
    if [ -f "$HOME/.zshrc" ]; then RC_FILE="$HOME/.zshrc"
    elif [ -f "$HOME/.bashrc" ]; then RC_FILE="$HOME/.bashrc"
    else RC_FILE="$HOME/.zshrc"
    fi
    if ! grep -qs "export PATH=\"$BIN_DIR:\$PATH\"" "$RC_FILE"; then
      printf '\n# Added by csm-agent installer\nexport PATH="%s:$PATH"\n' "$BIN_DIR" >> "$RC_FILE"
      say "已把 $BIN_DIR 加入 PATH（写入 ${RC_FILE}，新开终端生效）"
    fi
    ;;
esac

# ---------------------------------------------------------------------------
# 桌面 App（缺 swiftc 时降级跳过）
if command -v swiftc >/dev/null 2>&1; then
  say "构建桌面 App（Swift WKWebView 壳）"
  ( cd "$APP_DIR" && CSM_PORT="$PORT" bash scripts/build-mac-app.sh )
  APP_BUNDLE="$APP_DIR/dist-mac/$APP_NAME.app"
  APP_LINK="$APPS_DIR/$APP_NAME.app"
  mkdir -p "$APPS_DIR"
  if [ -w "$APPS_DIR" ]; then
    ln -sfn "$APP_BUNDLE" "$APP_LINK"
    say "桌面 App 入口: $APP_LINK"
  else
    say "（$APPS_DIR 不可写，跳过创建入口；可手动 ln -sfn "$APP_BUNDLE" "$APP_LINK"）"
  fi
else
  say "（未找到 swiftc，跳过桌面 App 构建；CLI 与服务不受影响。安装 Xcode CLT 后可重跑安装命令补上）"
fi

# ---------------------------------------------------------------------------
# 常驻服务
if [ "$arg_no_service" = true ]; then
  say "按 --no-service 跳过常驻服务安装"
else
  say "安装 launchd 常驻服务（端口 ${PORT}）"
  ( cd "$APP_DIR" && "$NODE_BIN" dist/cli.js service install "$PORT" )
  sleep 2
fi

# ---------------------------------------------------------------------------
say "自检 (doctor)"
( cd "$APP_DIR" && CSM_PORT="$PORT" "$NODE_BIN" dist/cli.js doctor ) || true

say "安装完成 🎉"
echo ""
echo "  命令行:   csm-agent version   （新开终端，或 source ~/.zshrc）"
echo "  桌面端:   打开 /Applications/$APP_NAME.app"
[ "$arg_no_service" = false ] && echo "  服务:     http://127.0.0.1:$PORT （launchd 常驻，开机自启）"
echo "  更新:     csm-agent update    （或重跑安装命令）"
echo "  卸载:     csm-agent uninstall"
echo ""
echo "  下一步: 配置凭据后开始使用 ——"
echo "    1) 打开 App → 左下角 ⚙️ 设置 → 添加 MCP 服务器（CRM / ONES / Hemory）"
echo "    2) 大模型: csm-agent config llm set --provider=... --model=... [--api-key=...]"
echo "    3) 搜索:   编辑 $DATA_DIR/config/search.user.yaml（Tavily key 可选，缺省走免费匿名通道）"
