import { spawnSync } from 'node:child_process';
import {
  chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, renameSync, rmSync, statfsSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { userConfigDir } from './config.js';
import { servicePaths, startServiceAfterRestore, stopServiceForRestore } from './service.js';
import { dataDir } from './store.js';
import { shanghaiDateKey, shanghaiIsoOffset, shanghaiSlot } from './workbench/sync.js';
import type { WorkbenchDatabase } from './workbench/database.js';
import type { SyncRun } from './workbench/types.js';
import { readBuildInfo } from './version.js';

/** 每日自动备份槽位：上海时区 04:00（02:00 组合同步之后、避开 Hemory 13/20 与 web-intel 夜窗的常触点）。 */
export const BACKUP_HOUR = 4;
/** 磁盘上保留的最近归档数（用户拍板：保留 3 天即可）。 */
export const BACKUP_RETENTION = 3;
/** 恢复标记文件名（恢复完成后由 CLI 落在数据目录，服务启动时消费成 backup_restore 审计后删除）。 */
export const RESTORE_MARKER = '.last-restore.json';

const ARCHIVE_PATTERN = /^csm-backup-\d{8}-\d{6}\.tar\.gz$/;
/** dataDir 根下的裸快照命名两种历史变体：resegment 的 workbench-backup-* 与手动 sqlite3 .backup 的 workbench.backup-*。 */
const STRAY_SNAPSHOT_PATTERN = /^workbench[.-]backup-.*\.sqlite$/;

export type BackupTrigger = 'scheduled' | 'manual';

export interface BackupManifest {
  id: string;
  createdAt: string;
  trigger: BackupTrigger;
  buildId: string | null;
  includes: { database: boolean; sessions: boolean; attachments: boolean; config: boolean };
  files: Array<{ path: string; bytes: number }>;
}

export interface BackupResult {
  archivePath: string;
  manifest: BackupManifest;
  pruned: string[];
}

export interface BackupInfo {
  id: string;
  file: string;
  bytes: number;
  mtime: string;
  createdAt: string | null;
  trigger: string | null;
  buildId: string | null;
  includes: BackupManifest['includes'] | null;
  manifestOk: boolean;
}

export function backupsDir(dir: string): string {
  return join(dir, 'backups');
}

/** 归档 id：csm-backup-YYYYMMDD-HHMMSS（上海时区，文件名安全字符，字典序即时间序）。 */
export function backupId(now = new Date()): string {
  return `csm-backup-${shanghaiIsoOffset(now).slice(0, 19).replace(/[-:]/g, '').replace('T', '-')}`;
}

/** 备份范围内的 .env 位置：显式 CSM_ENV_FILE 优先，否则数据目录下的 .env（cwd/packageRoot 的 .env 不属于用户数据）。 */
function envFileTarget(dir: string): string {
  return process.env.CSM_ENV_FILE ? resolve(process.env.CSM_ENV_FILE) : join(dir, '.env');
}

function listFilesRecursively(root: string, prefix = ''): Array<{ path: string; bytes: number }> {
  const files: Array<{ path: string; bytes: number }> = [];
  for (const name of readdirSync(join(root, prefix))) {
    const rel = prefix ? `${prefix}/${name}` : name;
    const stat = statSync(join(root, rel));
    if (stat.isDirectory()) files.push(...listFilesRecursively(root, rel));
    else files.push({ path: rel, bytes: stat.size });
  }
  return files;
}

/** 全量备份：DB 在线快照（VACUUM INTO，WAL 下一致性读）+ 会话/附件/配置 打成单个 tar.gz。 */
export function runBackup(db: WorkbenchDatabase, dir: string, trigger: BackupTrigger): BackupResult {
  const backupDir = backupsDir(dir);
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  // 空闲空间守卫：快照 + 归档约 2×DB 体量；把盘写满会连累 WAL 与整个服务，宁可不备。
  const dbBytes = statSync(db.path).size;
  const fsStat = statfsSync(backupDir);
  if (Number(fsStat.bsize) * Number(fsStat.bavail) < 2 * dbBytes) {
    throw new Error(`磁盘空闲空间不足（备份约需 ${Math.ceil((2 * dbBytes) / 1_048_576)} MB），已中止`);
  }
  const now = new Date();
  const id = backupId(now);
  const staging = join(backupDir, `.staging-${process.pid}-${now.getTime()}`);
  mkdirSync(staging);
  try {
    db.backupTo(join(staging, 'workbench.sqlite'));
    const includes = { database: true, sessions: false, attachments: false, config: false };
    if (existsSync(join(dir, 'sessions'))) {
      cpSync(join(dir, 'sessions'), join(staging, 'sessions'), { recursive: true });
      includes.sessions = true;
    }
    if (existsSync(join(dir, 'records.json'))) {
      copyFileSync(join(dir, 'records.json'), join(staging, 'records.json'));
      includes.sessions = true;
    }
    if (existsSync(join(dir, 'attachments'))) {
      cpSync(join(dir, 'attachments'), join(staging, 'attachments'), { recursive: true });
      includes.attachments = true;
    }
    const configDir = userConfigDir();
    if (existsSync(configDir)) {
      for (const name of readdirSync(configDir).filter((f) => f.endsWith('.user.yaml'))) {
        mkdirSync(join(staging, 'config'), { recursive: true });
        copyFileSync(join(configDir, name), join(staging, 'config', name));
        chmodSync(join(staging, 'config', name), 0o600);
        includes.config = true;
      }
    }
    const envPath = envFileTarget(dir);
    if (existsSync(envPath)) {
      copyFileSync(envPath, join(staging, '.env'));
      chmodSync(join(staging, '.env'), 0o600);
      includes.config = true;
    }
    const manifest: BackupManifest = { id, createdAt: now.toISOString(), trigger,
      buildId: readBuildInfo()?.buildId ?? null, includes, files: listFilesRecursively(staging) };
    writeFileSync(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    const archivePath = join(backupDir, `${id}.tar.gz`);
    const tar = spawnSync('/usr/bin/tar', ['-czf', archivePath, '-C', staging, '.'], { encoding: 'utf8' });
    if (tar.status !== 0) throw new Error(`tar 打包失败: ${(tar.stderr || tar.stdout).trim()}`);
    chmodSync(archivePath, 0o600);
    const pruned = pruneBackups(backupDir, dir);
    return { archivePath, manifest, pruned };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** 保留策略清理：归档/重切快照各留最近 BACKUP_RETENTION 份，24h 前的 staging 残留一并清掉。 */
function pruneBackups(backupDir: string, dir: string): string[] {
  const pruned: string[] = [];
  const archives = readdirSync(backupDir).filter((f) => ARCHIVE_PATTERN.test(f)).sort();
  for (const name of archives.slice(0, Math.max(0, archives.length - BACKUP_RETENTION))) {
    unlinkSync(join(backupDir, name));
    pruned.push(name);
  }
  const dayAgoMs = Date.now() - 24 * 3_600_000;
  for (const name of readdirSync(backupDir)) {
    if (!name.startsWith('.staging-')) continue;
    const path = join(backupDir, name);
    if (statSync(path).mtimeMs < dayAgoMs) {
      rmSync(path, { recursive: true, force: true });
      pruned.push(name);
    }
  }
  // dataDir 根下重切/手动裸快照此前从不清理：纳入同一保留策略（含点分隔的 workbench.backup-* 历史变体）。
  const strays = readdirSync(dir)
    .filter((f) => STRAY_SNAPSHOT_PATTERN.test(f))
    .map((f) => join(dir, f))
    .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);
  for (const path of strays.slice(0, Math.max(0, strays.length - BACKUP_RETENTION))) {
    rmSync(path, { force: true });
    for (const suffix of ['-wal', '-shm']) {
      const side = `${path}${suffix}`;
      if (existsSync(side)) rmSync(side, { force: true });
    }
    pruned.push(basename(path));
  }
  // 主文件已被单独删掉的孤儿 -wal/-shm（真实机上发生过）随每次备份顺手清掉。
  for (const name of readdirSync(dir)) {
    const match = name.match(/^(workbench[.-]backup-.*)\.sqlite-(wal|shm)$/);
    if (!match || existsSync(join(dir, `${match[1]}.sqlite`))) continue;
    rmSync(join(dir, name), { force: true });
    pruned.push(name);
  }
  return pruned;
}

let backupInFlight = false;

/** 触发一次备份（定时/手动同路径）：建 run 行即返回，工作 setImmediate 异步执行，run 行是进度权威。 */
export function triggerBackup(db: WorkbenchDatabase, dir: string, trigger: BackupTrigger, actor = 'system'): { run: SyncRun } {
  if (backupInFlight) throw new Error('备份已在进行中，请稍后用 csm-agent backup list 查看最近结果');
  const run = db.createSyncRun(`backup:${shanghaiDateKey()}`);
  backupInFlight = true;
  setImmediate(() => {
    try {
      const result = runBackup(db, dir, trigger);
      db.finishSyncRun(run.id, 'succeeded', { backup: { status: 'ok', archive: result.archivePath, trigger, pruned: result.pruned } });
      db.audit(actor, 'backup_create', 'backup', result.manifest.id,
        { archive: result.archivePath, trigger, files: result.manifest.files.length, pruned: result.pruned });
    } catch (error) {
      const message = String((error as Error).message);
      try {
        db.finishSyncRun(run.id, 'failed', { backup: { status: 'error', error: message } }, message);
      } catch (finishError) {
        // run 行落库失败（如服务关闭中连接已断）不能让 setImmediate 回调变成 uncaughtException。
        console.error(`[backup] 备份失败且 run 行落库失败: ${String((finishError as Error).message)}`);
      }
      console.error(`[backup] 备份失败: ${message}`);
    } finally {
      backupInFlight = false;
    }
  });
  return { run };
}

function readManifestFromArchive(path: string): BackupManifest | null {
  const tar = spawnSync('/usr/bin/tar', ['-xzOf', path, './manifest.json'], { encoding: 'utf8' });
  if (tar.status !== 0) return null;
  try {
    return JSON.parse(tar.stdout) as BackupManifest;
  } catch {
    return null;
  }
}

/** 列出备份归档（最新在前）：manifest 从归档内读取，损坏/缺 manifest 的归档也列出（manifestOk=false）。 */
export function listBackups(dir: string): BackupInfo[] {
  const backupDir = backupsDir(dir);
  if (!existsSync(backupDir)) return [];
  return readdirSync(backupDir)
    .filter((f) => ARCHIVE_PATTERN.test(f))
    .sort()
    .reverse()
    .map((file) => {
      const path = join(backupDir, file);
      const stat = statSync(path);
      const manifest = readManifestFromArchive(path);
      return { id: file.replace(/\.tar\.gz$/, ''), file: path, bytes: stat.size, mtime: stat.mtime.toISOString(),
        createdAt: manifest?.createdAt ?? null, trigger: manifest?.trigger ?? null, buildId: manifest?.buildId ?? null,
        includes: manifest?.includes ?? null, manifestOk: manifest != null };
    });
}

export function nextBackupSlot(now = new Date()): { at: Date; date: string } {
  const date = shanghaiDateKey(now);
  const at = shanghaiSlot(date, BACKUP_HOUR);
  if (at > now) return { at, date };
  const tomorrow = shanghaiDateKey(new Date(now.getTime() + 24 * 3_600_000));
  return { at: shanghaiSlot(tomorrow, BACKUP_HOUR), date: tomorrow };
}

/** 启动补跑判定（同 Hemory 模式）：今日槽位已过而库里没有当日成功备份（手动备份同样计入）就补一次。 */
export function shouldCatchUpBackup(db: WorkbenchDatabase, now = new Date()): boolean {
  const date = shanghaiDateKey(now);
  return shanghaiSlot(date, BACKUP_HOUR) <= now && !db.hasSuccessfulSyncScope(`backup:${date}`);
}

/** 每日备份调度器：setTimeout 链（自校准无漂移、unref 不阻塞退出），返回 stop 函数（server close 时清理）。 */
export function scheduleBackup(db: WorkbenchDatabase, dir: string): () => void {
  let timer: NodeJS.Timeout | undefined;
  const fire = () => {
    try {
      triggerBackup(db, dir, 'scheduled');
    } catch (error) {
      console.error(`[backup] 定时备份触发失败: ${String((error as Error).message)}`);
    }
  };
  if (shouldCatchUpBackup(db)) fire();
  const schedule = () => {
    const next = nextBackupSlot();
    timer = setTimeout(() => {
      fire();
      schedule();
    }, Math.max(0, next.at.getTime() - Date.now()));
    timer.unref();
  };
  schedule();
  return () => timer && clearTimeout(timer);
}

// ── 恢复（离线：必须没有任何进程持有 DB，由 CLI 在服务停止后调用） ────────────

export interface BackupServiceController {
  installed(): boolean;
  stop(): void;
  start(): void;
}

export const launchdServiceController: BackupServiceController = {
  installed: () => existsSync(servicePaths().plist),
  stop: stopServiceForRestore,
  start: startServiceAfterRestore,
};

export interface RestoreOptions {
  /** 只恢复数据库（会话/附件/配置保持现状）。 */
  dbOnly?: boolean;
  /** 服务启停 seam（默认 launchd 控制器；测试注入假实现）。 */
  service?: BackupServiceController;
  /** 端口探活：停服务后仍可达说明有未受监管的手动进程持有数据，恢复必须中止。 */
  probeAlive?: () => Promise<boolean>;
  onStep?: (message: string) => void;
}

export interface RestoreResult {
  archiveId: string;
  archivePath: string;
  dbOnly: boolean;
  rollbackDir: string;
  markerPath: string;
  serviceRestarted: boolean;
}

function resolveArchive(input: string, dir: string): string {
  if (input === 'latest') {
    const latest = listBackups(dir)[0];
    if (!latest) throw new Error('backups 目录没有任何归档，无 latest 可用');
    return latest.file;
  }
  if (input.includes('/')) return resolve(input);
  return join(backupsDir(dir), input.endsWith('.tar.gz') ? input : `${input}.tar.gz`);
}

function verifySnapshot(path: string): void {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const check = db.prepare('PRAGMA quick_check').get() as { quick_check?: string } | undefined;
    if (check?.quick_check !== 'ok') throw new Error(`快照完整性校验失败: ${check?.quick_check ?? 'unknown'}`);
    const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='audit_log'").get();
    if (!table) throw new Error('快照缺少 audit_log 表（不是 csm-agent workbench 数据库）');
  } finally {
    db.close();
  }
}

function moveIfExists(path: string, rollbackDir: string, relative: string): void {
  if (!existsSync(path)) return;
  const target = join(rollbackDir, relative);
  mkdirSync(join(target, '..'), { recursive: true });
  renameSync(path, target);
}

/** 恢复归档：校验 → 停服务 → 探活守卫 → 现有数据移入回滚目录 → 应用 → 落恢复标记 → 重启服务。 */
export async function restoreBackup(archiveInput: string, dir: string, options: RestoreOptions = {}): Promise<RestoreResult> {
  const archivePath = resolveArchive(archiveInput, dir);
  if (!existsSync(archivePath)) throw new Error(`备份归档不存在: ${archiveInput}`);
  options.onStep?.(`校验归档 ${basename(archivePath)}`);
  const staging = mkdtempSync(join(tmpdir(), 'csm-restore-'));
  try {
    const extract = spawnSync('/usr/bin/tar', ['-xzf', archivePath, '-C', staging], { encoding: 'utf8' });
    if (extract.status !== 0) throw new Error(`归档解包失败（可能已损坏）: ${(extract.stderr || extract.stdout).trim()}`);
    if (!existsSync(join(staging, 'manifest.json'))) throw new Error('归档缺少 manifest.json（不是 csm-agent 备份归档）');
    const manifest = JSON.parse(readFileSync(join(staging, 'manifest.json'), 'utf8')) as BackupManifest;
    const snapshotPath = join(staging, 'workbench.sqlite');
    if (!existsSync(snapshotPath)) throw new Error('归档缺少 workbench.sqlite 快照');
    verifySnapshot(snapshotPath);

    const controller = options.service ?? launchdServiceController;
    const wasInstalled = controller.installed();
    if (wasInstalled) {
      options.onStep?.('停止 launchd 服务');
      controller.stop();
    }
    // 停了常驻服务端口还能响应 = 有未受监管的手动进程持有数据目录，替换文件属未定义行为，必须中止。
    if (options.probeAlive && await options.probeAlive()) {
      if (wasInstalled) controller.start();
      throw new Error('端口上仍有服务进程在响应（手动启动的 dev 服务？）；请先停止它再恢复');
    }

    const stamp = new Date();
    const rollbackDir = join(dir, `.restore-rollback-${stamp.getTime()}`);
    mkdirSync(rollbackDir);
    options.onStep?.(`现有数据移入回滚目录 ${basename(rollbackDir)}`);
    moveIfExists(join(dir, 'workbench.sqlite'), rollbackDir, 'workbench.sqlite');
    moveIfExists(join(dir, 'workbench.sqlite-wal'), rollbackDir, 'workbench.sqlite-wal');
    moveIfExists(join(dir, 'workbench.sqlite-shm'), rollbackDir, 'workbench.sqlite-shm');
    if (!options.dbOnly) {
      moveIfExists(join(dir, 'sessions'), rollbackDir, 'sessions');
      moveIfExists(join(dir, 'records.json'), rollbackDir, 'records.json');
      moveIfExists(join(dir, 'attachments'), rollbackDir, 'attachments');
      const configDir = userConfigDir();
      if (existsSync(configDir)) {
        for (const name of readdirSync(configDir).filter((f) => f.endsWith('.user.yaml'))) {
          moveIfExists(join(configDir, name), rollbackDir, join('config', name));
        }
      }
      moveIfExists(envFileTarget(dir), rollbackDir, '.env');
    }

    options.onStep?.('应用备份数据');
    copyFileSync(snapshotPath, join(dir, 'workbench.sqlite'));
    if (!options.dbOnly) {
      if (existsSync(join(staging, 'sessions'))) cpSync(join(staging, 'sessions'), join(dir, 'sessions'), { recursive: true });
      if (existsSync(join(staging, 'records.json'))) copyFileSync(join(staging, 'records.json'), join(dir, 'records.json'));
      if (existsSync(join(staging, 'attachments'))) cpSync(join(staging, 'attachments'), join(dir, 'attachments'), { recursive: true });
      if (existsSync(join(staging, 'config'))) {
        const configDir = userConfigDir();
        mkdirSync(configDir, { recursive: true, mode: 0o700 });
        for (const name of readdirSync(join(staging, 'config'))) {
          copyFileSync(join(staging, 'config', name), join(configDir, name));
          chmodSync(join(configDir, name), 0o600);
        }
      }
      if (existsSync(join(staging, '.env'))) {
        const envPath = envFileTarget(dir);
        copyFileSync(join(staging, '.env'), envPath);
        chmodSync(envPath, 0o600);
      }
    }

    // 恢复标记：服务启动时消费成 backup_restore 审计后删除——CLI 全程不直接写 DB，保持单写者。
    const markerPath = join(dir, RESTORE_MARKER);
    writeFileSync(markerPath, JSON.stringify({ archive: manifest.id, archivePath, restoredAt: stamp.toISOString(),
      dbOnly: options.dbOnly === true, rollbackDir: basename(rollbackDir) }, null, 2), 'utf8');

    let serviceRestarted = false;
    if (wasInstalled) {
      options.onStep?.('重启 launchd 服务');
      controller.start();
      serviceRestarted = true;
    }
    return { archiveId: manifest.id, archivePath, dbOnly: options.dbOnly === true, rollbackDir, markerPath, serviceRestarted };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** 服务启动时消费恢复标记：落 backup_restore 审计后删除（审计失败也删，避免每次启动重复审计）。 */
export function consumeRestoreMarker(db: WorkbenchDatabase, dir: string): void {
  const markerPath = join(dir, RESTORE_MARKER);
  if (!existsSync(markerPath)) return;
  try {
    const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as { archive?: string; restoredAt?: string; dbOnly?: boolean; rollbackDir?: string };
    db.audit('system', 'backup_restore', 'backup', String(marker.archive ?? 'unknown'),
      { restoredAt: marker.restoredAt ?? null, dbOnly: marker.dbOnly === true, rollbackDir: marker.rollbackDir ?? null });
  } catch (error) {
    console.error(`[backup] 恢复标记消费失败（backup_restore 审计未落库）: ${String((error as Error).message)}`);
  } finally {
    unlinkSync(markerPath);
  }
}

// dataDir 供 CLI/服务端取默认数据目录（与 store.ts 同源）。
export { dataDir };
