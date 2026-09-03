#!/usr/bin/env bash
# CSM Agent 一键安装 / 更新（macOS）。
#
# 推荐形式（先下载后执行：curl 失败会立刻显式报错，避免 `curl | bash` 空输入静默"成功"）:
#   curl -fsSL --retry 3 https://raw.githubusercontent.com/opyamorpen/csm-agent/main/scripts/install.sh -o /tmp/csm-agent-install.sh && bash /tmp/csm-agent-install.sh
# 管道形式同样可用:
#   curl -fsSL https://raw.githubusercontent.com/opyamorpen/csm-agent/main/scripts/install.sh | bash
#
# 安装布局（用户数据与代码分离，更新/卸载不触碰数据）:
#   ~/.csm-agent/app                      受管代码目录（git clone）
#   ~/.csm-agent/node                     捆绑 Node 22 LTS（仅当系统 node <22.5，下载后 SHA256 校验）
#   ~/.local/bin/csm-agent                CLI shim（固化 CSM_DATA_DIR，指向本安装的数据目录）
#   /Applications/CSM Agent.app           → app/dist-mac 符号链接
#   ~/Library/LaunchAgents/cn.csm-agent.service.plist   常驻服务（--no-service 跳过）
#   ~/.csm-agent/{config,sessions,*.sqlite,logs}        用户数据，永不触碰
#
# 已安装时重跑本脚本 = 更新（git fetch + reset --hard origin/<branch> + 重建）；
# 目录存在但不是受管安装时自动移到 *.broken-<时间戳> 后全新克隆（重跑必定自愈）。
# 可选: --repo <git地址|本地路径> --branch <分支>（默认 main；CSM_INSTALL_REPO / CSM_INSTALL_BRANCH 同效）
# 隔离验收: bash scripts/install.sh --dir <dir> --bin-dir <dir> --data-dir <dir> --apps-dir <dir> --port <p> --no-service
set -euo pipefail

REPO_URL="${CSM_INSTALL_REPO:-https://github.com/opyamorpen/csm-agent.git}"
BRANCH="${CSM_INSTALL_BRANCH:-main}"
NODE_VERSION="22.23.2"
APP_NAME="CSM Agent"

arg_dir=""
arg_bin_dir=""
arg_data_dir=""
arg_apps_dir=""
arg_port=""
arg_repo=""
arg_branch=""
arg_no_service=false
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) arg_dir="$2"; shift 2 ;;
    --bin-dir) arg_bin_dir="$2"; shift 2 ;;
    --data-dir) arg_data_dir="$2"; shift 2 ;;
    --apps-dir) arg_apps_dir="$2"; shift 2 ;;
    --port) arg_port="$2"; shift 2 ;;
    --repo) arg_repo="$2"; shift 2 ;;
    --branch) arg_branch="$2"; shift 2 ;;
    --no-service) arg_no_service=true; shift ;;
    *) echo "未知参数: $1（支持 --dir/--bin-dir/--data-dir/--apps-dir/--port/--repo/--branch/--no-service）" >&2; exit 2 ;;
  esac
done
[ -n "$arg_repo" ] && REPO_URL="$arg_repo"
[ -n "$arg_branch" ] && BRANCH="$arg_branch"

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m错误:\033[0m %s\n' "$*" >&2; exit 1; }

command -v git >/dev/null 2>&1 || die "缺少 git。请先安装 Xcode Command Line Tools: xcode-select --install 后重试"
[ "$(uname -s)" = "Darwin" ] || die "install.sh 目前只支持 macOS"

DATA_DIR="${arg_data_dir:-$HOME/.csm-agent}"
APP_DIR="${arg_dir:-$DATA_DIR/app}"
BIN_DIR="${arg_bin_dir:-$HOME/.local/bin}"
APPS_DIR="${arg_apps_dir:-/Applications}"
PORT="${arg_port:-3210}"
case "$PORT" in
  ''|*[!0-9]*) die "端口必须是 1-65535 的整数: $PORT" ;;
esac
[ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || die "端口必须是 1-65535 的整数: $PORT"
export CSM_DATA_DIR="$DATA_DIR"

# ---------------------------------------------------------------------------
say "安装目录: ${APP_DIR}（数据目录 ${DATA_DIR}）"

# ---------------------------------------------------------------------------
# Node 运行时: 系统 node >=22.5 可用则复用，否则下载捆绑 Node 到 $DATA_DIR/node（SHA256 校验）
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
  # 捆绑 Node 只在版本与钉住的完全一致时复用（旧 22.x 不混用）
  if [ -x "$node_bin" ] && [ "$("$node_bin" --version)" = "v${NODE_VERSION}" ]; then
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
  curl -fsSL --retry 3 -o "$node_root.tmp/SHASUMS256.txt" "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" \
    || die "下载 Node 校验文件（SHASUMS256.txt）失败，请检查网络后重试"
  (cd "$node_root.tmp" && grep "  $tarball\$" SHASUMS256.txt | shasum -a 256 -c -) \
    || die "Node tarball SHA256 校验失败（下载可能不完整），请重试"
  tar -xzf "$node_root.tmp/$tarball" -C "$node_root.tmp"
  mv "$node_root.tmp/node-v${NODE_VERSION}-darwin-${arch}" "$node_root"
  rm -rf "$node_root.tmp"
  NODE_BIN="$node_bin"
  NODE_DIR_BINDN="$node_root/bin"
  say "捆绑 Node 就绪: $("$node_bin" --version)（SHA256 校验通过）"
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
# layout 用 node 生成（JSON.stringify 保证任意路径/端口安全转义）
write_layout() {
  APP_DIR="$APP_DIR" BIN_DIR="$BIN_DIR" APPS_DIR="$APPS_DIR" PORT="$PORT" BRANCH="$BRANCH" \
  NODE_DIR="${NODE_DIR_BINDN:+$(dirname "$NODE_DIR_BINDN")}" \
  SERVICE="$([ "$arg_no_service" = true ] && echo true || echo false)" \
    "$NODE_BIN" -e '
      const fs = require("fs");
      const layout = {
        method: "install.sh",
        appDir: process.env.APP_DIR,
        binDir: process.env.BIN_DIR,
        appsDir: process.env.APPS_DIR,
        port: Number(process.env.PORT),
        branch: process.env.BRANCH,
        nodeDir: process.env.NODE_DIR || null,
        service: process.env.SERVICE === "true",
      };
      fs.writeFileSync(process.env.APP_DIR + "/.install-layout.json", JSON.stringify(layout, null, 2) + "\n");
    '
  echo "install.sh" > "$APP_DIR/.install_method"
}

# ---------------------------------------------------------------------------
clone_or_update() {
  if [ -e "$APP_DIR/.install_method" ]; then
    say "检测到已有安装，走更新路径（${BRANCH}）"
    (cd "$APP_DIR" \
      && git fetch origin "$BRANCH" \
      && git reset --hard "origin/$BRANCH" \
      && git clean -fdq -- dist dist-mac .build-mac) \
      || die "拉取远端更新失败（git fetch/reset），请检查网络后重跑"
    return
  fi
  if [ -e "$APP_DIR" ]; then
    # 半截安装或无关残留：代码目录不含用户数据，自动移开保证重跑自愈
    local backup="$APP_DIR.broken-$(date +%Y%m%d%H%M%S)"
    say "$APP_DIR 已存在但不是受管安装，移到 $backup 后全新克隆"
    mv "$APP_DIR" "$backup"
  fi
  say "克隆仓库到 ${APP_DIR}（${REPO_URL} @ ${BRANCH}）"
  git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$APP_DIR" \
    || die "克隆仓库失败，请检查网络或 --repo/--branch 参数"
}

clone_or_update
write_layout

# ---------------------------------------------------------------------------
say "安装依赖并构建（npm ci）"
( cd "$APP_DIR" && "$NPM_BIN" ci ) || die "npm ci 失败，请检查网络后重跑安装命令（重跑会自动续装）"
( cd "$APP_DIR" && "$NPM_BIN" run build ) || die "构建失败；请把上方错误反馈给维护者后重试"
export CSM_SKIP_SERVER_BUILD=1  # 桌面 App 脚本跳过内部重复构建（dist 刚构建过）

# ---------------------------------------------------------------------------
# CLI shim（固化 CSM_DATA_DIR：非默认 --data-dir 安装时 CLI 与服务/数据保持一致）
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
CSM_DATA_DIR="$DATA_DIR"
export CSM_DATA_DIR
exec "$NODE_BIN_ABS" "$APP_DIR/dist/cli.js" "\$@"
EOF
chmod +x "$SHIM"
say "CLI shim 就绪: $SHIM"

# PATH: $BIN_DIR 不在 PATH 时按登录 shell 追加到对应 rc 文件
case ":$PATH:" in
  *":$BIN_DIR:"*) : ;;
  *)
    case "$(basename "${SHELL:-/bin/zsh}")" in
      bash) RC_FILE="$HOME/.bash_profile" ;;
      zsh)  RC_FILE="$HOME/.zshrc" ;;
      *)    RC_FILE="$HOME/.profile" ;;
    esac
    touch "$RC_FILE"
    if ! grep -qs "export PATH=\"$BIN_DIR:\$PATH\"" "$RC_FILE"; then
      printf '\n# Added by csm-agent installer\nexport PATH="%s:$PATH"\n' "$BIN_DIR" >> "$RC_FILE"
      say "已把 $BIN_DIR 加入 PATH（写入 ${RC_FILE}，新开终端或 source 后生效）"
    fi
    ;;
esac

# ---------------------------------------------------------------------------
# 桌面 App（缺 swiftc 时降级跳过；构建失败不阻断 CLI/服务）
APP_BUILT=false
if command -v swiftc >/dev/null 2>&1; then
  say "构建桌面 App（Swift WKWebView 壳）"
  if ( cd "$APP_DIR" && CSM_PORT="$PORT" bash scripts/build-mac-app.sh ); then
    APP_BUILT=true
  else
    say "警告: 桌面 App 构建失败（CLI 与服务不受影响）；修复环境后重跑安装命令即可补上"
  fi
else
  say "（未找到 swiftc（Xcode Command Line Tools），跳过桌面 App；执行 xcode-select --install 后重跑安装命令可补上）"
fi
APP_BUNDLE="$APP_DIR/dist-mac/$APP_NAME.app"
APP_LINK="$APPS_DIR/$APP_NAME.app"
if [ "$APP_BUILT" = true ] && [ -d "$APP_BUNDLE" ]; then
  mkdir -p "$APPS_DIR"
  if [ -w "$APPS_DIR" ]; then
    ln -sfn "$APP_BUNDLE" "$APP_LINK"
    say "桌面 App 入口: $APP_LINK"
  else
    say "（$APPS_DIR 不可写，跳过创建入口；可手动 ln -sfn "$APP_BUNDLE" "$APP_LINK"）"
  fi
fi

# ---------------------------------------------------------------------------
# 等待服务就绪并校验构建一致性（/api/version 的 buildId 必须等于磁盘构建戳且非 stale）
wait_service_ready() {
  local timeout_s="$1" waited=0 info service_build_id stale
  local expected_build_id
  expected_build_id="$(cd "$APP_DIR" && "$NODE_BIN" -p 'try { JSON.parse(require("fs").readFileSync("dist/build-info.json","utf8")).buildId } catch { "" }')"
  while [ "$waited" -lt "$timeout_s" ]; do
    info="$(curl -fsS --max-time 2 "http://127.0.0.1:${PORT}/api/version" 2>/dev/null \
      | "$NODE_BIN" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const v=JSON.parse(s);console.log((v.buildId??"")+"\t"+String(v.stale??""))}catch{console.log("\t")}})' || true)"
    if [ -n "$info" ]; then
      service_build_id="${info%%$'\t'*}"
      stale="${info##*$'\t'}"
      if [ -n "$service_build_id" ] && [ "$service_build_id" = "$expected_build_id" ] && [ "$stale" != "true" ]; then
        say "服务就绪: buildId ${service_build_id}（stale=false）"
        return 0
      fi
    fi
    sleep 2; waited=$((waited + 2))
  done
  echo "服务未在 ${timeout_s}s 内就绪。服务日志尾部:" >&2
  tail -n 30 "$DATA_DIR/logs/service.error.log" 2>/dev/null >&2 || true
  tail -n 30 "$DATA_DIR/logs/service.log" 2>/dev/null >&2 || true
  die "服务就绪校验失败；请查看上方日志或执行 csm-agent service logs 排障"
}

# 常驻服务
if [ "$arg_no_service" = true ]; then
  say "按 --no-service 跳过常驻服务安装"
else
  say "安装 launchd 常驻服务（端口 ${PORT}）"
  ( cd "$APP_DIR" && "$NODE_BIN" dist/cli.js service install "$PORT" ) || die "launchd 服务安装失败"
  say "等待服务就绪并校验构建一致性（至多 60 秒）"
  wait_service_ready 60
fi

# ---------------------------------------------------------------------------
if [ "$arg_no_service" = true ]; then
  say "（--no-service 模式跳过 doctor 自检）"
else
  say "自检 (doctor)"
  ( cd "$APP_DIR" && CSM_PORT="$PORT" "$NODE_BIN" dist/cli.js doctor ) || die "doctor 自检失败；服务可能异常，请执行 csm-agent service logs 排障"
fi

say "安装完成 🎉"
echo ""
echo "  安装指纹（与开发机比对: 两端 csm-agent version --json，gitSha 一致即同一份代码构建）:"
echo "    commit:   $(git -C "$APP_DIR" rev-parse HEAD)"
echo "    branch:   ${BRANCH}"
echo "    node:     $("$NODE_BIN" --version)"
echo "    buildId:  $(cd "$APP_DIR" && "$NODE_BIN" -p 'try { JSON.parse(require("fs").readFileSync("dist/build-info.json","utf8")).buildId } catch { "" }')"
if [ "$APP_BUILT" = true ]; then echo "    桌面 App: 已构建"; else echo "    桌面 App: 未构建"; fi
if [ "$arg_no_service" = true ]; then echo "    服务:     未安装（--no-service）"; else echo "    服务:     http://127.0.0.1:$PORT 已就绪（launchd 常驻，开机自启）"; fi
echo ""
echo "  命令行:   csm-agent version --json   （新开终端，或 source 对应 rc 文件）"
echo "  桌面端:   打开 /Applications/$APP_NAME.app"
echo "  更新:     csm-agent update    （或重跑安装命令；失败自动回滚到更新前构建）"
echo "  卸载:     csm-agent uninstall"
echo ""
echo "  下一步: 配置凭据后开始使用 ——"
echo "    1) 打开 App → 左下角 ⚙️ 设置 → 添加 MCP 服务器（CRM / ONES / Hemory）"
echo "    2) 大模型: csm-agent config llm set --provider=... --model=... [--api-key=...]"
echo "    3) 搜索:   编辑 $DATA_DIR/config/search.user.yaml（Tavily key 可选，缺省走免费匿名通道）"
