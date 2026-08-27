import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { appRoot, pathAliases, readInstallLayout } from './managed-install.js';
import { servicePaths, uninstallService } from './service.js';
import { dataDir } from './store.js';

export interface UninstallOptions {
  purge: boolean;
  yes: boolean;
}

export const SHIM_MARKER = '# csm-agent managed shim';

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** shim 只有内容带标记且指向本安装（或符号链接落入本安装目录）才允许删除。 */
function shimBelongsToInstall(path: string, rootAliases: string[]): boolean {
  try {
    if (lstatSync(path).isSymbolicLink()) {
      const target = readlinkSync(path);
      return rootAliases.some((alias) => target.includes(alias));
    }
    if (statSync(path).isFile()) {
      const content = readFileSync(path, 'utf8');
      return content.includes(SHIM_MARKER) && rootAliases.some((alias) => content.includes(alias));
    }
  } catch {
    return false;
  }
  return false;
}

/** macOS 上 /tmp 与 /private/tmp 互为别名；安装时写入的路径可能是任一形式。 */
function pathAliasesLocal(path: string): string[] {
  return pathAliases(path);
}

/** /Applications 里的入口只有符号链接且精确指向本安装的 App 才删除；真实目录绝不动。 */
function appLinkBelongsToInstall(path: string, rootAliases: string[]): boolean {
  try {
    if (!lstatSync(path).isSymbolicLink()) return false;
    const target = readlinkSync(path);
    return rootAliases.some((alias) => target === join(alias, 'dist-mac', 'CSM Agent.app'));
  } catch {
    return false;
  }
}

export async function runUninstall(options: UninstallOptions, rootInput?: string): Promise<void> {
  const root = rootInput ?? appRoot();
  const layout = readInstallLayout(root);
  if (!layout) {
    throw new Error('当前不是一键安装的受管目录（缺少 .install-layout.json）；开发 checkout 直接删除目录即可');
  }
  // macOS 的 /tmp 是 /private/tmp 的符号链接，git 与 realpath 都可能把任一形式写进文件。
  // 归属判断对 layout 记录的原始路径与其别名形式都接受；删除按记录的原始路径执行。
  const rootAliases = pathAliasesLocal(layout.appDir);
  const steps: Record<string, unknown> = { appDir: root };

  // 1. 常驻服务：仅当 plist 存在且引用本安装目录时才卸载，避免误动其他环境的服务。
  const plist = servicePaths().plist;
  if (existsSync(plist) && rootAliases.some((alias) => readFileSync(plist, 'utf8').includes(alias))) {
    steps.service = uninstallService();
  } else {
    steps.service = { skipped: '服务未安装或不属于此安装' };
  }

  // 2. CLI shim。
  const shim = join(layout.binDir, 'csm-agent');
  if (shimBelongsToInstall(shim, rootAliases)) {
    unlinkSync(shim);
    steps.shim = { removed: shim };
  } else if (existsSync(shim) || isSymlink(shim)) {
    steps.shim = { skipped: '非本安装的 csm-agent，未删除', path: shim };
  } else {
    steps.shim = { skipped: '不存在' };
  }

  // 3. /Applications 桌面入口。
  const appLink = join(layout.appsDir, 'CSM Agent.app');
  if (appLinkBelongsToInstall(appLink, rootAliases)) {
    unlinkSync(appLink);
    steps.appLink = { removed: appLink };
  } else if (existsSync(appLink) || isSymlink(appLink)) {
    steps.appLink = { skipped: '非本安装的 App 入口（真实目录或指向别处），未删除', path: appLink };
  } else {
    steps.appLink = { skipped: '不存在' };
  }

  // 4. 受管代码目录与捆绑 Node（原始与别名形式都清，防符号链接残留）。
  for (const dir of new Set([root, ...rootAliases])) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
  steps.appDirRemoved = true;
  if (layout.nodeDir && existsSync(layout.nodeDir)) {
    rmSync(layout.nodeDir, { recursive: true, force: true });
    steps.nodeDir = { removed: layout.nodeDir };
  }

  // 5. 用户数据默认保留；--purge 需确认（--yes 跳过确认）。
  // dataDir 必须落在用户主目录下（CSM_DATA_DIR 指向别处时删除前先校验归属）。
  const data = dataDir();
  if (options.purge) {
    const dataReal = pathAliases(data);
    const homeReal = realpathSync(homedir());
    if (!dataReal.some((candidate) => candidate.startsWith(homeReal))) {
      throw new Error(`拒绝清除不在用户主目录下的数据目录: ${data}`);
    }
    if (!options.yes) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = (await rl.question(`将永久删除全部本地数据（配置、会话、数据库、日志）: ${data}\n不可恢复，确认？ [y/N] `)).trim().toLowerCase();
      rl.close();
      if (answer !== 'y' && answer !== 'yes') throw new Error('已取消，数据未删除');
    }
    rmSync(data, { recursive: true, force: true });
    steps.purgedData = data;
  } else {
    steps.dataRetained = data;
  }
  console.log(JSON.stringify(steps, null, 2));
}
