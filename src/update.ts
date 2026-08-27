import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { appRoot, isManagedInstall, readInstallLayout, readPackageVersion } from './managed-install.js';
import { restartService, servicePaths, serviceStatus } from './service.js';

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
  desktop: 'rebuilt' | 'skipped' | 'failed';
  serviceRestarted: boolean;
}

export interface UpdateHooks {
  /** 替换默认的 npm ci + npm run build（测试注入用）。 */
  runBuildSteps?: (root: string) => void;
  /** 替换默认的桌面 App 重建（测试注入用）。 */
  rebuildDesktop?: (root: string) => 'rebuilt' | 'skipped' | 'failed';
}

function git(root: string, gitArgs: string[]): string {
  const result = spawnSync('git', gitArgs, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${gitArgs.join(' ')} 失败: ${(result.stderr || result.stdout).trim()}`);
  return (result.stdout ?? '').trim();
}

function nodeBinDir(): string {
  return dirname(process.execPath);
}

function run(command: string, commandArgs: string[], cwd: string, stdio: 'inherit' | 'pipe'): string {
  const env = { ...process.env, PATH: `${nodeBinDir()}:${process.env.PATH ?? ''}` };
  const result = spawnSync(command, commandArgs, { cwd, env, encoding: 'utf8', stdio: stdio === 'inherit' ? 'inherit' : undefined });
  if (result.status !== 0) throw new Error(`${command} ${commandArgs.join(' ')} 失败: ${String(result.stderr ?? result.stdout ?? '').trim().slice(0, 2000)}`);
  return String(result.stdout ?? '');
}

function npmCommand(): string {
  const sibling = join(nodeBinDir(), 'npm');
  return existsSync(sibling) ? sibling : 'npm';
}

/** fetch 远端并对比 HEAD；localChanges 只看被跟踪文件的改动（安装标记是 untracked，不算）。 */
export function planUpdate(root: string, branch = 'main'): UpdatePlan {
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
    run('bash', [join(root, 'scripts', 'build-mac-app.sh')], root, stdio);
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

function restartServiceIfInstalled(root: string): boolean {
  if (!serviceBelongsToRoot(root)) return false;
  try {
    if (serviceStatus().running === false) return false;
    restartService();
    return true;
  } catch {
    return false;
  }
}

export function applyUpdate(root: string, plan: UpdatePlan, hooks: UpdateHooks = {}, stdio: 'inherit' | 'pipe' = 'inherit'): UpdateReport {
  const oldVersion = readPackageVersion(root);
  git(root, ['reset', '--hard', `origin/${plan.branch}`]);
  if (hooks.runBuildSteps) {
    hooks.runBuildSteps(root);
  } else {
    run(npmCommand(), ['ci'], root, stdio);
    run(npmCommand(), ['run', 'build'], root, stdio);
  }
  const desktop = hooks.rebuildDesktop ? hooks.rebuildDesktop(root) : rebuildDesktopApp(root, stdio);
  const serviceRestarted = restartServiceIfInstalled(root);
  return { status: 'updated', oldVersion, newVersion: readPackageVersion(root), head: plan.newHead, desktop, serviceRestarted };
}

export async function runUpdate(rootInput?: string): Promise<void> {
  const root = rootInput ?? appRoot();
  if (!isManagedInstall(root)) {
    throw new Error('当前不是一键安装的受管目录（缺少 .install_method 标记）；开发 checkout 请直接 git pull，或先运行 scripts/install.sh');
  }
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
  const report = applyUpdate(root, plan);
  console.log(JSON.stringify(report, null, 2));
}
