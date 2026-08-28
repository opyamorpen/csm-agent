import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 一次构建的标识：gitSha(12)+dirty/clean+构建时刻；服务端内存值与磁盘值以此为比对锚点。 */
export interface BuildInfo {
  buildId: string;
  gitSha: string | null;
  dirty: boolean;
  builtAt: string;
}

export interface ServiceVersionInfo extends BuildInfo {
  startedAt: string;
  pid: number;
  cwd: string;
  node: string;
  supervised: boolean;
  /** 磁盘上的构建已不同于进程启动时加载的构建（未受监管时仅标记，受监管时进程会自动退出换新）。 */
  stale: boolean;
}

/**
 * 读 dist/build-info.json。repo 根相对 import.meta.url 定位：
 * src 运行（tsx）与 dist 运行（node dist）都在 repo 根下的 src/ 或 dist/ 内，../dist 两者通吃。
 * 路径可注入（单测写临时目录）；文件缺失（从未构建）返回 null，不抛错。
 */
export function readBuildInfo(distDir?: string): BuildInfo | null {
  const dir = distDir ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
  const file = join(dir, 'build-info.json');
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<BuildInfo>;
    if (typeof raw.buildId !== 'string' || !raw.buildId) return null;
    return { buildId: raw.buildId, gitSha: typeof raw.gitSha === 'string' ? raw.gitSha : null,
      dirty: raw.dirty === true, builtAt: typeof raw.builtAt === 'string' ? raw.builtAt : '' };
  } catch { return null; }
}

/** 组装 /api/version 响应：进程启动时加载的构建 + 运行态 + 实时磁盘比对。 */
export function serviceVersionInfo(loaded: BuildInfo | null, startedAt: string, distDir?: string): ServiceVersionInfo {
  const onDisk = readBuildInfo(distDir);
  return {
    ...(loaded ?? { buildId: 'unknown', gitSha: null, dirty: false, builtAt: '' }),
    startedAt,
    pid: process.pid,
    cwd: process.cwd(),
    node: process.version,
    supervised: process.env.CSM_SUPERVISED === '1',
    // 磁盘无构建信息（从未构建/异常）不算 stale；有且不同才是旧进程。
    stale: onDisk != null && loaded != null && onDisk.buildId !== loaded.buildId,
  };
}

/** 受监管自愈：dist 更新后 10s 内退出（exit 0），由 launchd KeepAlive / Mac App terminationHandler 拉起新构建。 */
export const STALENESS_CHECK_INTERVAL_MS = 10_000;

/**
 * 启动陈旧性自检。回调设计（而非直接 process.exit）便于单测注入行为。
 * 返回定时器句柄（server close 时清理；unref 不阻塞进程退出）。
 */
export function startStalenessWatch(loaded: BuildInfo | null, options: {
  distDir?: string;
  intervalMs?: number;
  onReload?: () => void;
} = {}): NodeJS.Timeout | null {
  if (!loaded) return null;
  const check = () => {
    const onDisk = readBuildInfo(options.distDir);
    if (onDisk && onDisk.buildId !== loaded.buildId) options.onReload?.();
  };
  const timer = setInterval(check, options.intervalMs ?? STALENESS_CHECK_INTERVAL_MS);
  timer.unref();
  return timer;
}
