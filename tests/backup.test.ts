import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync,
  statSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  backupId, backupsDir, consumeRestoreMarker, listBackups, nextBackupSlot,
  RESTORE_MARKER, restoreBackup, runBackup, shouldCatchUpBackup, triggerBackup,
  type BackupServiceController,
} from '../src/backup.js';
import { WorkbenchDatabase } from '../src/workbench/database.js';

/** 数据目录脚手架：sessions/records/attachments/config/.env 全量可备份形态。 */
function seedDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'csm-backup-'));
  mkdirSync(join(dir, 'sessions'));
  writeFileSync(join(dir, 'sessions', 's1.json'), JSON.stringify({ id: 's1', title: '会话一', messages: [], events: [] }), 'utf8');
  writeFileSync(join(dir, 'records.json'), JSON.stringify({ records: [] }), 'utf8');
  mkdirSync(join(dir, 'attachments', 's1'), { recursive: true });
  writeFileSync(join(dir, 'attachments', 's1', 'manifest.json'), '{}', 'utf8');
  mkdirSync(join(dir, 'config'), { recursive: true });
  writeFileSync(join(dir, 'config', 'llm.user.yaml'), 'provider: custom\napiKey: secret-key\n', 'utf8');
  chmodSync(join(dir, 'config', 'llm.user.yaml'), 0o600);
  writeFileSync(join(dir, '.env'), 'ONES_TOKEN=abc\n', 'utf8');
  return dir;
}

/** CSM_DATA_DIR 覆盖到临时目录（userConfigDir/envFileTarget 从 env 取路径），测试后还原。 */
function withDataDir(dir: string, fn: () => void | Promise<void>): Promise<void> | void {
  const originalData = process.env.CSM_DATA_DIR;
  const originalEnvFile = process.env.CSM_ENV_FILE;
  process.env.CSM_DATA_DIR = dir;
  delete process.env.CSM_ENV_FILE;
  return Promise.resolve(fn()).finally(() => {
    if (originalData === undefined) delete process.env.CSM_DATA_DIR;
    else process.env.CSM_DATA_DIR = originalData;
    if (originalEnvFile === undefined) delete process.env.CSM_ENV_FILE;
    else process.env.CSM_ENV_FILE = originalEnvFile;
  });
}

function extractArchive(archivePath: string, target: string): void {
  mkdirSync(target, { recursive: true });
  const tar = spawnSync('/usr/bin/tar', ['-xzf', archivePath, '-C', target], { encoding: 'utf8' });
  assert.equal(tar.status, 0, tar.stderr);
}

/** 只读连接查同库（WAL 允许并发读）：断言审计行专用。 */
function auditActionsOf(dbPath: string): string[] {
  const ro = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return (ro.prepare('SELECT action FROM audit_log ORDER BY id').all() as Array<{ action: string }>).map((row) => row.action);
  } finally {
    ro.close();
  }
}

const fakeController = (): BackupServiceController & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    installed: () => true,
    stop: () => calls.push('stop'),
    start: () => calls.push('start'),
  };
};

test('backup: 每日槽位 04:00（上海）跨日界正确翻到明天', () => {
  // 固定时刻断言（days:0 惯例防日历翻转炸弹）：03:00 → 今日 04:00；05:00 → 明日 04:00。
  const before = nextBackupSlot(new Date('2026-09-04T03:00:00+08:00'));
  assert.equal(before.date, '2026-09-04');
  assert.equal(before.at.getTime(), new Date('2026-09-04T04:00:00+08:00').getTime());
  const after = nextBackupSlot(new Date('2026-09-04T05:00:00+08:00'));
  assert.equal(after.date, '2026-09-05');
  assert.equal(after.at.getTime(), new Date('2026-09-05T04:00:00+08:00').getTime());
  // 恰在槽位时刻（at > now 为假）→ 明日；UTC 视角跨上海日界（17:00Z = 次日 01:00 上海）仍取上海日。
  const atSlot = nextBackupSlot(new Date('2026-09-04T04:00:00+08:00'));
  assert.equal(atSlot.date, '2026-09-05');
  const utcEvening = nextBackupSlot(new Date('2026-09-03T17:00:00Z'));
  assert.equal(utcEvening.date, '2026-09-04');
  assert.equal(utcEvening.at.getTime(), new Date('2026-09-03T20:00:00Z').getTime());
  // 归档 id 以上海时区命名且字典序即时间序。
  assert.equal(backupId(new Date('2026-09-03T20:00:00Z')), 'csm-backup-20260904-040000');
});

test('backup: runBackup 打出含 manifest/快照/会话/附件/配置的单归档', () => withDataDir(seedDataDir(), () => {
  const dir = process.env.CSM_DATA_DIR!;
  const db = new WorkbenchDatabase(dir);
  try {
    db.upsertCustomer({ id: 'crm-1', name: '客户甲', renewalDate: null });
    const result = runBackup(db, dir, 'manual');
    assert.match(result.manifest.id, /^csm-backup-\d{8}-\d{6}$/);
    assert.equal(result.manifest.trigger, 'manual');
    assert.deepEqual(result.manifest.includes, { database: true, sessions: true, attachments: true, config: true });
    assert.ok(result.manifest.files.some((f) => f.path === 'workbench.sqlite'));
    assert.ok(existsSync(result.archivePath));
    assert.equal(statSync(result.archivePath).mode & 0o777, 0o600, '归档须 0600（内含密钥）');
    const listed = listBackups(dir);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].trigger, 'manual');
    assert.equal(listed[0].manifestOk, true);
    assert.equal(listed[0].includes!.config, true);
    // 解包核验内容物：快照可读且数据在、敏感文件齐全。
    const extracted = join(dir, '.test-extract');
    try {
      extractArchive(result.archivePath, extracted);
      for (const rel of ['manifest.json', 'workbench.sqlite', 'sessions/s1.json', 'records.json', 'attachments/s1/manifest.json', 'config/llm.user.yaml', '.env']) {
        assert.ok(existsSync(join(extracted, rel)), `归档缺少 ${rel}`);
      }
      const ro = new DatabaseSync(join(extracted, 'workbench.sqlite'), { readOnly: true });
      try {
        assert.equal((ro.prepare('SELECT count(*) AS n FROM customers').get() as { n: number }).n, 1);
      } finally {
        ro.close();
      }
    } finally {
      rmSync(extracted, { recursive: true, force: true });
    }
  } finally {
    db.close();
  }
}));

test('backup: 保留策略——归档与重切散落快照各留最近 3 份，旧 staging 残留清理', () => withDataDir(seedDataDir(), () => {
  const dir = process.env.CSM_DATA_DIR!;
  const backupDir = backupsDir(dir);
  mkdirSync(backupDir, { recursive: true });
  for (const day of ['01', '02', '03', '04', '05']) writeFileSync(join(backupDir, `csm-backup-202601${day}-000000.tar.gz`), 'old');
  // 4 个重切前快照（现网从不清理的散落文件），mtime 递增；外加点分隔的手动 .backup 变体（最新）。
  const strays = ['a', 'b', 'c', 'd'].map((tag, index) => {
    const path = join(dir, `workbench-backup-2026010${index + 1}T00-00-${tag}.sqlite`);
    writeFileSync(path, 'x');
    utimesSync(path, new Date(`2026-01-0${index + 1}T00:00:00Z`), new Date(`2026-01-0${index + 1}T00:00:00Z`));
    return path;
  });
  const dotVariant = join(dir, 'workbench.backup-20260106-120000.sqlite');
  writeFileSync(dotVariant, 'x');
  utimesSync(dotVariant, new Date('2026-01-06T12:00:00Z'), new Date('2026-01-06T12:00:00Z'));
  // 主文件已被单独删掉的孤儿 -shm（真实机发生过），与仍在的主文件的 -wal（随主文件策略）。
  writeFileSync(join(dir, 'workbench-backup-gone.sqlite-shm'), 'y');
  const liveSide = `${strays[3]}-wal`;
  writeFileSync(liveSide, 'y');
  // 25h 前的 staging 残留（打包中途进程被杀）。
  const staleStaging = join(backupDir, '.staging-1-0');
  mkdirSync(staleStaging);
  utimesSync(staleStaging, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));

  const db = new WorkbenchDatabase(dir);
  try {
    const result = runBackup(db, dir, 'scheduled');
    // 6 份归档（5 旧 + 1 新）→ 只留最新 3：0104、0105、新归档。
    const remaining = readdirSync(backupDir).filter((f) => f.endsWith('.tar.gz')).sort();
    assert.deepEqual(remaining.slice(0, 2), ['csm-backup-20260104-000000.tar.gz', 'csm-backup-20260105-000000.tar.gz']);
    assert.equal(remaining.length, 3);
    assert.ok(result.pruned.includes('csm-backup-20260101-000000.tar.gz'));
    // 散落快照 5（含点分隔变体）→ 留最新 3：最旧的 a、b 被清，b 的 side 未建、a 无 side。
    assert.ok(!existsSync(strays[0]) && !existsSync(strays[1]), '最旧散落快照应被清理');
    for (const kept of [strays[2], strays[3], dotVariant]) assert.ok(existsSync(kept));
    assert.ok(result.pruned.some((name) => name.startsWith('workbench-backup-')));
    assert.ok(result.pruned.some((name) => name.startsWith('workbench.backup-')) || existsSync(dotVariant), '点分隔变体须被识别');
    // 孤儿 -shm 直接清；主文件还在的 -wal 保留（未来随主文件一起走）。
    assert.ok(!existsSync(join(dir, 'workbench-backup-gone.sqlite-shm')), '孤儿 -shm 应被清理');
    assert.ok(existsSync(liveSide), '主文件仍存在的 -wal 不应被单独清理');
    assert.ok(!existsSync(staleStaging), '24h 前的 staging 残留应被清理');
  } finally {
    db.close();
  }
}));

test('backup: 启动补跑判定——当日槽位已过且无成功备份才补', () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-backup-'));
  const db = new WorkbenchDatabase(dir);
  try {
    const afterSlot = new Date('2026-09-04T05:00:00+08:00');
    const beforeSlot = new Date('2026-09-04T03:00:00+08:00');
    assert.equal(shouldCatchUpBackup(db, beforeSlot), false, '槽位未到不补跑');
    assert.equal(shouldCatchUpBackup(db, afterSlot), true, '槽位已过且当日无成功备份应补跑');
    // 前一天的备份不算今日。
    const otherDay = db.createSyncRun('backup:2026-09-03');
    db.finishSyncRun(otherDay.id, 'succeeded', {});
    assert.equal(shouldCatchUpBackup(db, afterSlot), true);
    // 当日成功备份（手动触发同样计入）后不再补跑。
    const today = db.createSyncRun('backup:2026-09-04');
    db.finishSyncRun(today.id, 'succeeded', {});
    assert.equal(shouldCatchUpBackup(db, afterSlot), false);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('backup: triggerBackup 建 run 即返回、完成后落 succeeded 与 backup_create 审计', () => withDataDir(seedDataDir(), async () => {
  const dir = process.env.CSM_DATA_DIR!;
  const db = new WorkbenchDatabase(dir);
  try {
    const { run } = triggerBackup(db, dir, 'manual');
    assert.equal(run.status, 'running');
    let final = db.getSyncRun(run.id)!;
    for (let i = 0; i < 100 && final.status === 'running'; i++) {
      // 真 sleep 让事件循环转起来，setImmediate 里的备份工作才有机会执行。
      await new Promise((resolve) => setTimeout(resolve, 100));
      final = db.getSyncRun(run.id)!;
    }
    assert.equal(final.status, 'succeeded');
    assert.ok(final.sourceStatus.backup?.archive, 'run 行应带归档路径');
    assert.ok(existsSync(final.sourceStatus.backup!.archive));
    assert.ok(auditActionsOf(db.path).includes('backup_create'));
    assert.equal(listBackups(dir).length, 1);
  } finally {
    db.close();
  }
}));

test('backup: restore 全量恢复——数据回滚到归档态、现有数据移入回滚目录、落恢复标记', () => withDataDir(seedDataDir(), async () => {
  const dir = process.env.CSM_DATA_DIR!;
  let db = new WorkbenchDatabase(dir);
  db.upsertCustomer({ id: 'crm-1', name: '客户甲', renewalDate: null });
  const { archivePath } = runBackup(db, dir, 'manual');
  db.close();
  // 备份后继续演进：新客户、删会话、改配置、删 .env。
  db = new WorkbenchDatabase(dir);
  db.upsertCustomer({ id: 'crm-2', name: '客户乙', renewalDate: null });
  db.close();
  rmSync(join(dir, 'sessions', 's1.json'));
  writeFileSync(join(dir, 'config', 'llm.user.yaml'), 'provider: other\n', 'utf8');
  rmSync(join(dir, '.env'));

  const controller = fakeController();
  const result = await restoreBackup('latest', dir, { service: controller, probeAlive: async () => false });
  // 服务停启各一次（launchd seam 注入的假实现）。
  assert.deepEqual(controller.calls, ['stop', 'start']);
  assert.equal(result.serviceRestarted, true);
  assert.match(result.archiveId, /^csm-backup-\d{8}-\d{6}$/);
  // 全量内容回到归档态。
  assert.ok(existsSync(join(dir, 'sessions', 's1.json')), '会话应恢复');
  assert.equal(readFileSync(join(dir, 'config', 'llm.user.yaml'), 'utf8'), 'provider: custom\napiKey: secret-key\n');
  assert.ok(existsSync(join(dir, '.env')));
  const ro = new DatabaseSync(join(dir, 'workbench.sqlite'), { readOnly: true });
  try {
    assert.equal((ro.prepare("SELECT count(*) AS n FROM customers WHERE id='crm-2'").get() as { n: number }).n, 0, '备份后的新客户应被回滚掉');
    assert.equal((ro.prepare("SELECT count(*) AS n FROM customers WHERE id='crm-1'").get() as { n: number }).n, 1);
  } finally {
    ro.close();
  }
  // 现有数据（含被改写的配置）整体移入回滚目录。
  assert.ok(existsSync(join(result.rollbackDir, 'workbench.sqlite')));
  assert.ok(existsSync(join(result.rollbackDir, 'config', 'llm.user.yaml')));
  // 恢复标记：服务启动时消费成 backup_restore 审计后删除。
  assert.ok(existsSync(result.markerPath));
  consumeRestoreMarker(db = new WorkbenchDatabase(dir), dir);
  assert.ok(!existsSync(join(dir, RESTORE_MARKER)));
  assert.ok(auditActionsOf(db.path).includes('backup_restore'));
  db.close();
}));

test('backup: restore --db-only 只替换数据库，会话/配置保持现状', () => withDataDir(seedDataDir(), async () => {
  const dir = process.env.CSM_DATA_DIR!;
  let db = new WorkbenchDatabase(dir);
  db.upsertCustomer({ id: 'crm-1', name: '客户甲', renewalDate: null });
  const { archivePath } = runBackup(db, dir, 'manual');
  db.close();
  // 备份后新增会话 s2 与新客户。
  db = new WorkbenchDatabase(dir);
  db.upsertCustomer({ id: 'crm-2', name: '客户乙', renewalDate: null });
  db.close();
  writeFileSync(join(dir, 'sessions', 's2.json'), '{}', 'utf8');

  const controller = fakeController();
  const result = await restoreBackup(archivePath, dir, { dbOnly: true, service: controller, probeAlive: async () => false });
  assert.equal(result.dbOnly, true);
  assert.ok(existsSync(join(dir, 'sessions', 's2.json')), '--db-only 不动会话');
  assert.equal(readFileSync(join(dir, 'config', 'llm.user.yaml'), 'utf8'), 'provider: custom\napiKey: secret-key\n');
  const ro = new DatabaseSync(join(dir, 'workbench.sqlite'), { readOnly: true });
  try {
    assert.equal((ro.prepare("SELECT count(*) AS n FROM customers WHERE id='crm-2'").get() as { n: number }).n, 0);
  } finally {
    ro.close();
  }
  assert.ok(!existsSync(join(result.rollbackDir, 'sessions')), 'db-only 回滚目录不应包含会话');
}));

test('backup: 损坏归档在校验期即被拒，停服务动作不发生', () => withDataDir(seedDataDir(), async () => {
  const dir = process.env.CSM_DATA_DIR!;
  const controller = fakeController();
  mkdirSync(backupsDir(dir), { recursive: true });
  const broken = join(backupsDir(dir), 'csm-backup-20260101-000000.tar.gz');
  writeFileSync(broken, '这不是一个 tar.gz');
  await assert.rejects(
    restoreBackup('csm-backup-20260101-000000', dir, { service: controller, probeAlive: async () => false }),
    /解包失败|损坏/,
  );
  assert.deepEqual(controller.calls, [], '校验失败时不得停服务');
  assert.ok(!existsSync(join(dir, RESTORE_MARKER)));
}));

test('backup: 停服务后端口仍响应（手动 dev 进程）→ 中止恢复并回滚停机动作', () => withDataDir(seedDataDir(), async () => {
  const dir = process.env.CSM_DATA_DIR!;
  const db = new WorkbenchDatabase(dir);
  const { archivePath } = runBackup(db, dir, 'manual');
  db.close();
  const controller = fakeController();
  await assert.rejects(
    restoreBackup(archivePath, dir, { service: controller, probeAlive: async () => true }),
    /仍有服务进程在响应/,
  );
  assert.deepEqual(controller.calls, ['stop', 'start'], '停机动作应回滚（服务重新拉起）');
  assert.ok(!existsSync(join(dir, RESTORE_MARKER)), '中止路径不得写恢复标记');
  assert.ok(!readdirSync(dir).some((f) => f.startsWith('.restore-rollback-')), '中止路径不得动现有数据');
}));
