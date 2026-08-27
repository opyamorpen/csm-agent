import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface InstallLayout {
  method: string;
  appDir: string;
  binDir: string;
  appsDir: string;
  port: number;
  branch?: string;
  nodeDir?: string | null;
  service?: boolean;
}

export const INSTALL_METHOD_FILE = '.install_method';
export const INSTALL_LAYOUT_FILE = '.install-layout.json';

/** 受管安装的代码目录：dist/managed-install.js → 仓库根（dev 下 src/ → 仓库根）。 */
export function appRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

/** macOS 上 node 会 realpath 主模块（/tmp → /private/tmp），安装标记路径可能是任一形式。 */
export function pathAliases(path: string): string[] {
  const aliases = new Set([path]);
  try {
    aliases.add(realpathSync(path));
  } catch {
    /* 不存在时仅原形式 */
  }
  return [...aliases];
}

/** 是否为 install.sh 安装的受管目录（区别于开发 checkout / npm link）。 */
export function isManagedInstall(root = appRoot()): boolean {
  return existsSync(join(root, INSTALL_METHOD_FILE));
}

export function readInstallLayout(root = appRoot()): InstallLayout | null {
  // layout 由 install.sh 用原始路径写入；node 主模块被 realpath 后 root 可能是别名形式，
  // 两种形式都尝试读取。appDir 保留文件里记录的原始形式（uninstall 的删除路径依据）。
  for (const candidate of pathAliases(root)) {
    const path = join(candidate, INSTALL_LAYOUT_FILE);
    if (!existsSync(path)) continue;
    try {
      const layout = JSON.parse(readFileSync(path, 'utf8')) as InstallLayout;
      if (layout.appDir && layout.binDir) return layout;
    } catch {
      /* 损坏的 layout 视为不存在，继续尝试 */
    }
  }
  return null;
}

export function readPackageVersion(root: string): string {
  try {
    const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: string };
    return packageJson.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}
