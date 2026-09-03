import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { appRoot, isManagedInstall, readInstallLayout, readPackageVersion } from './managed-install.js';
import { launchAgentLabel, renderLaunchAgent, restartService, servicePaths, serviceStatus } from './service.js';

export interface UpdatePlan {
  action: 'up-to-date' | 'update';
  oldHead: string;
  newHead: string;
  localChanges: string[];
  branch: string;
}

export interface UpdateReport {
  status: 'updated';
  oldVersion: string;
  newVersion: string;
  head: string;
  buildId: string | null;
  desktop: 'rebuilt' | 'skipped' | 'failed';
  serviceRestarted: boolean;
  /** null = 无常驻服务（未安装/不属于本目录）；false = 已重启但超时未确认换新，需人工检查。 */
  serviceVerified: boolean | null;
}

export interface UpdateHooks {
  /** 替换默认的 npm ci + npm run build（测试注入用）。 */
  runBuildSteps?: (root: string) => void;
  /** 替换默认的回滚步骤（git reset 之后的 npm ci + npm run build；测试注入用）。 */
  runRestoreSteps?: (root: string) => void;
  /** 替换默认的桌面 App 重建（测试注入用）。 */
  rebuildDesktop?: (root: string) => 'rebuilt' | 'skipped' | 'failed';
}

/** 升级中途失败（依赖/构建等）且已尝试回滚到 oldHead 的错误。 */
export class UpdateFailedError extends Error {
  constructor(message: string, public readonly rollback: 'restored' | 'failed') {
    super(message);
  }
}

function git(root: string, gitArgs: string[]): string {
  const result = spawnSync('git', gitArgs, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${gitArgs.join(' ')} 失败: ${(result.stderr || result.stdout).trim()}`);
  return (result.stdout ?? '').trim();
}

function ensureGitAvailable(): void {
  const probe = spawnSync('git', ['--version'], { encoding: 'utf8' });
  if (probe.status !== 0) throw new Error('缺少 git，无法更新。请先安装 Xcode Command Line Tools: xcode-select --install 后重试');
}

function nodeBinDir(): string {
  return dirname(process.execPath);
}

function run(
  command: string,
  commandArgs: string[],
  cwd: string,
  stdio: 'inherit' | 'pipe',
  extraEnv: Record<string, string> = {},
): string {
  const env = { ...process.env, ...extraEnv, PATH: `${nodeBinDir()}:${process.env.PATH ?? ''}` };
  const result = spawnSync(command, commandArgs, { cwd, env, encoding: 'utf8', stdio: stdio === 'inherit' ? 'inherit' : undefined });
  if (result.status !== 0) throw new Error(`${command} ${commandArgs.join(' ')} 失败: ${String(result.stderr ?? result.stdout ?? '').trim().slice(0, 2000)}`);
  return String(result.stdout ?? '');
}

function npmCommand(): string {
  const sibling = join(nodeBinDir(), 'npm');
  return existsSync(sibling) ? sibling : 'npm';
}

function readDistBuildId(root: string): string | null {
  try {
    const info = JSON.parse(readFileSync(join(root, 'dist', 'build-info.json'), 'utf8')) as { buildId?: string };
    return info.buildId ?? null;
  } catch {
    return null;
  }
}

/** fetch 远端并对比 HEAD；localChanges 只看被跟踪文件的改动（安装标记是 untracked，不算）。 */
export function planUpdate(root: string, branch = 'main'): UpdatePlan {
  ensureGitAvailable();
  git(root, ['fetch', 'origin', branch]);
  const oldHead = git(root, ['rev-parse', 'HEAD']);
  const newHead = git(root, ['rev-parse', `origin/${branch}`]);
  const status = git(root, ['status', '--porcelain', '--untracked-files=no']);
  const localChanges = status ? status.split('\n').map((line) => line.trim()) : [];
  return { action: oldHead === newHead ? 'up-to-date' : 'update', oldHead, newHead, localChanges, branch };
}

function hasSwiftCompiler(): boolean {
  return spawnSync('swiftc', ['-version'], { encoding: 'utf8' }).status === 0;
}

function rebuildDesktopApp(root: string, stdio: 'inherit' | 'pipe'): 'rebuilt' | 'skipped' | 'failed' {
  if (!hasSwiftCompiler()) {
    console.log('警告: 未找到 swiftc（Xcode Command Line Tools），跳过桌面 App 重建');
    return 'skipped';
  }
  try {
    // CSM_SKIP_SERVER_BUILD=1：dist 刚构建过，桌面 App 脚本无需再重复 npm run build
    run('bash', [join(root, 'scripts', 'build-mac-app.sh')], root, stdio, { CSM_SKIP_SERVER_BUILD: '1' });
    return 'rebuilt';
  } catch (error) {
    console.log(`警告: 桌面 App 重建失败（不影响 CLI/服务）: ${(error as Error).message}`);
    return 'failed';
  }
}

/** launchd 服务是否属于当前安装目录（plist 内容引用该目录才允许重启，避免误动开发环境服务）。 */
export function serviceBelongsToRoot(root: string, plistPath = servicePaths().plist): boolean {
  if (!existsSync(plistPath)) return false;
  try {
    return readFileSync(plistPath, 'utf8').includes(root);
  } catch {
    return false;
  }
}

export interface PlistRestartPlan {
  action: 'kickstart' | 'rewrite';
  /** rewrite 时写入 plist 的 node 二进制（优先沿用既有 plist 的，避免换 node 跑 update 时静默换运行时）。 */
  nodeBin: string;
  existingNodeBin: string | null;
  existingPort: number | null;
}

function unescapeXml(value: string): string {
  return value.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/**
 * 纯函数决策：既有 launchd plist 需要重写还是只需 kickstart。
 * 重写条件（按语义而非整文件比对——node 二进制不同不该触发重写）:
 * ProgramArguments 的 cli 路径变了 / 端口与安装 layout 不符 / 缺 CSM_SUPERVISED 监管标记。
 */
export function planPlistRestart(existingContent: string, opts: { port: number; cliPath: string }): PlistRestartPlan {
  const arrayMatch = existingContent.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/);
  const strings = arrayMatch
    ? [...arrayMatch[1].matchAll(/<string>([^<]*)<\/string>/g)].map((match) => unescapeXml(match[1]))
    : [];
  const existingNodeBin = strings[0] ?? null;
  const existingCli = strings[1] ?? null;
  const portNumber = strings[3] != null ? Number(strings[3]) : NaN;
  const existingPort = Number.isInteger(portNumber) ? portNumber : null;
  const supervised = /<key>CSM_SUPERVISED<\/key>/.test(existingContent);
  const needsRewrite = (existingCli != null && existingCli !== opts.cliPath) || existingPort !== opts.port || !supervised;
  if (needsRewrite) {
    const nodeBin = existingNodeBin != null && existsSync(existingNodeBin) ? existingNodeBin : process.execPath;
    return { action: 'rewrite', nodeBin, existingNodeBin, existingPort };
  }
  return { action: 'kickstart', nodeBin: process.execPath, existingNodeBin, existingPort };
}

function restartServiceIfInstalled(root: string, port = 3210): boolean {
  if (!serviceBelongsToRoot(root)) return false;
  try {
    // plist 语义（端口/监管标记/cli 路径）需要演进时重写再 bootstrap，存量安装自动迁移；
    // 无需重写时保持 kickstart -k 原语义。
    const paths = servicePaths();
    if (existsSync(paths.plist)) {
      const plan = planPlistRestart(readFileSync(paths.plist, 'utf8'), { port, cliPath: paths.cli });
      if (plan.action === 'rewrite') {
        writeFileSync(paths.plist, renderLaunchAgent(port, plan.nodeBin), { encoding: 'utf8', mode: 0o600 });
        const domain = `gui/${process.getuid?.() ?? 0}`;
        spawnSync('/bin/launchctl', ['bootout', domain, paths.plist]);
        const boot = spawnSync('/bin/launchctl', ['bootstrap', domain, paths.plist], { encoding: 'utf8' });
        if (boot.status !== 0) throw new Error((boot.stderr || boot.stdout).trim());
        const kick = spawnSync('/bin/launchctl', ['kickstart', '-k', `${domain}/${launchAgentLabel()}`], { encoding: 'utf8' });
        if (kick.status !== 0) throw new Error((kick.stderr || kick.stdout).trim());
        return true;
      }
    }
    if (serviceStatus().running === false) return false;
    restartService();
    return true;
  } catch {
    return false;
  }
}

/** 轮询 /api/version 直到服务加载的 buildId 等于磁盘新构建且未 stale——「升级成功」的最终证据。 */
async function waitForServiceBuild(port: number, expectedBuildId: string, timeoutMs = 120_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/version`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) {
        const version = (await response.json()) as { buildId?: string; stale?: boolean };
        if (version.buildId === expectedBuildId && version.stale !== true) return true;
      }
    } catch {
      /* 服务尚未就绪（launchd 正在拉起），继续轮询 */
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return false;
}

/** 失败回滚：源码回到 oldHead 并重建旧构建。服务进程仍在跑旧内存代码（构建戳未推进就不会自退出换新）。 */
function restorePreviousBuild(root: string, oldHead: string, hooks: UpdateHooks, stdio: 'inherit' | 'pipe'): 'restored' | 'failed' {
  try {
    git(root, ['reset', '--hard', oldHead]);
    git(root, ['clean', '-fdq', '--', 'dist', 'dist-mac', '.build-mac']);
    if (hooks.runRestoreSteps) {
      hooks.runRestoreSteps(root);
    } else {
      run(npmCommand(), ['ci'], root, stdio);
      run(npmCommand(), ['run', 'build'], root, stdio);
    }
    return 'restored';
  } catch {
    return 'failed';
  }
}

export async function applyUpdate(
  root: string,
  plan: UpdatePlan,
  hooks: UpdateHooks = {},
  stdio: 'inherit' | 'pipe' = 'inherit',
  options: { port?: number } = {},
): Promise<UpdateReport> {
  const oldVersion = readPackageVersion(root);
  const port = options.port ?? 3210;
  git(root, ['reset', '--hard', `origin/${plan.branch}`]);
  git(root, ['clean', '-fdq', '--', 'dist', 'dist-mac', '.build-mac']);
  try {
    if (hooks.runBuildSteps) {
      hooks.runBuildSteps(root);
    } else {
      run(npmCommand(), ['ci'], root, stdio);
      run(npmCommand(), ['run', 'build'], root, stdio);
    }
  } catch (error) {
    const rollback = restorePreviousBuild(root, plan.oldHead, hooks, stdio);
    const rollbackHint = rollback === 'restored'
      ? `已回滚到 ${plan.oldHead.slice(0, 12)} 并恢复旧构建`
      : `回滚失败（源码已 reset 到 ${plan.oldHead.slice(0, 12)}，但依赖/构建未恢复）；运行中的服务仍是旧内存代码，网络恢复后重跑 csm-agent update 即可`;
    throw new UpdateFailedError(`更新失败（${(error as Error).message}）；${rollbackHint}`, rollback);
  }
  const desktop = hooks.rebuildDesktop ? hooks.rebuildDesktop(root) : rebuildDesktopApp(root, stdio);
  const serviceRestarted = restartServiceIfInstalled(root, port);
  const buildId = readDistBuildId(root);
  let serviceVerified: boolean | null = null;
  if (serviceRestarted && buildId) serviceVerified = await waitForServiceBuild(port, buildId);
  return {
    status: 'updated', oldVersion, newVersion: readPackageVersion(root), head: plan.newHead, buildId,
    desktop, serviceRestarted, serviceVerified,
  };
}

export async function runUpdate(rootInput?: string): Promise<void> {
  const root = rootInput ?? appRoot();
  if (!isManagedInstall(root)) {
    throw new Error('当前不是一键安装的受管目录（缺少 .install_method 标记）；开发 checkout 请直接 git pull，或先运行 scripts/install.sh');
  }
  ensureGitAvailable();
  const layout = readInstallLayout(root);
  const branch = layout?.branch ?? 'main';
  const plan = planUpdate(root, branch);
  if (plan.action === 'up-to-date') {
    console.log(JSON.stringify({ status: 'up-to-date', version: readPackageVersion(root), head: plan.oldHead }, null, 2));
    return;
  }
  if (plan.localChanges.length) {
    throw new Error(`受管目录存在被跟踪文件的本地改动，拒绝更新: ${plan.localChanges.slice(0, 5).join('; ')}；受管目录不应手工修改，确认丢弃可先执行 git -C "${root}" reset --hard 后重试`);
  }
  try {
    const report = await applyUpdate(root, plan, {}, 'inherit', { port: layout?.port ?? 3210 });
    console.log(JSON.stringify(report, null, 2));
    if (report.serviceVerified === false) {
      console.warn(`警告: 服务已重启但未在超时内确认运行新构建（buildId=${report.buildId}），请执行 csm-agent service status 检查`);
    }
  } catch (error) {
    if (error instanceof UpdateFailedError) {
      console.log(JSON.stringify({ status: 'failed', head: plan.newHead, error: error.message, rollback: error.rollback }, null, 2));
    }
    throw error;
  }
}
