import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDir } from './store.js';

export const LAUNCH_AGENT_LABEL = 'cn.csm-agent.service';

/** label 可被 CSM_LAUNCH_AGENT_LABEL 覆盖：隔离验收用它装一个不与本机常驻服务冲突的 agent。 */
export function launchAgentLabel(): string {
  const override = process.env.CSM_LAUNCH_AGENT_LABEL?.trim();
  return override || LAUNCH_AGENT_LABEL;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function servicePaths(): { plist: string; stdout: string; stderr: string; cli: string } {
  const logs = join(dataDir(), 'logs');
  const siblingCli = fileURLToPath(new URL('./cli.js', import.meta.url));
  const builtCli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  return {
    plist: join(homedir(), 'Library', 'LaunchAgents', `${launchAgentLabel()}.plist`),
    stdout: join(logs, 'service.log'),
    stderr: join(logs, 'service.error.log'),
    cli: existsSync(siblingCli) ? siblingCli : builtCli,
  };
}

/** nodeBin 默认取当前进程的 node；update 重写存量 plist 时优先沿用既有 plist 里的 node，避免静默换运行时。 */
export function renderLaunchAgent(port = 3210, nodeBin = process.execPath): string {
  const paths = servicePaths();
  const args = [nodeBin, paths.cli, 'serve', String(port)];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${launchAgentLabel()}</string>
  <key>ProgramArguments</key>
  <array>${args.map((arg) => `\n    <string>${escapeXml(arg)}</string>`).join('')}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CSM_SUPERVISED</key><string>1</string>
    <key>CSM_DATA_DIR</key><string>${escapeXml(dataDir())}</string>
  </dict>
  <key>StandardOutPath</key><string>${escapeXml(paths.stdout)}</string>
  <key>StandardErrorPath</key><string>${escapeXml(paths.stderr)}</string>
</dict>
</plist>
`;
}

function launchctl(...args: string[]) {
  return spawnSync('/bin/launchctl', args, { encoding: 'utf8' });
}

export function installService(port = 3210): Record<string, unknown> {
  // 端口校验先于平台检查：纯参数错误在任何环境都报同一文案。
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须是 1-65535 的整数');
  if (process.platform !== 'darwin') throw new Error('service install 当前只支持 macOS launchd');
  const paths = servicePaths();
  if (!existsSync(paths.cli)) throw new Error(`未找到构建后的 CLI: ${paths.cli}；请先运行 npm run build`);
  mkdirSync(dirname(paths.plist), { recursive: true });
  mkdirSync(dirname(paths.stdout), { recursive: true, mode: 0o700 });
  writeFileSync(paths.plist, renderLaunchAgent(port), { encoding: 'utf8', mode: 0o600 });
  const domain = `gui/${process.getuid?.() ?? 0}`;
  launchctl('bootout', domain, paths.plist);
  const boot = launchctl('bootstrap', domain, paths.plist);
  if (boot.status !== 0) throw new Error(`launchctl bootstrap 失败: ${(boot.stderr || boot.stdout).trim()}`);
  const kick = launchctl('kickstart', '-k', `${domain}/${LAUNCH_AGENT_LABEL}`);
  if (kick.status !== 0) throw new Error(`launchctl kickstart 失败: ${(kick.stderr || kick.stdout).trim()}`);
  return { installed: true, label: LAUNCH_AGENT_LABEL, port, ...paths };
}

export function serviceStatus(): Record<string, unknown> {
  const domain = `gui/${process.getuid?.() ?? 0}`;
  const result = launchctl('print', `${domain}/${launchAgentLabel()}`);
  return { installed: existsSync(servicePaths().plist), running: result.status === 0,
    detail: (result.stdout || result.stderr).trim().slice(0, 4000), ...servicePaths() };
}

export function restartService(): Record<string, unknown> {
  const domain = `gui/${process.getuid?.() ?? 0}`;
  const result = launchctl('kickstart', '-k', `${domain}/${launchAgentLabel()}`);
  if (result.status !== 0) throw new Error((result.stderr || result.stdout).trim());
  return serviceStatus();
}

export function uninstallService(): Record<string, unknown> {
  const paths = servicePaths();
  const domain = `gui/${process.getuid?.() ?? 0}`;
  launchctl('bootout', domain, paths.plist);
  if (existsSync(paths.plist)) unlinkSync(paths.plist);
  return { installed: false, removed: paths.plist, logsRetained: [paths.stdout, paths.stderr] };
}

/** 备份恢复用：bootout 数据服务（不动 plist 文件，bootstrap 权威源保留）。未安装返回 false。 */
export function stopServiceForRestore(): boolean {
  const paths = servicePaths();
  if (!existsSync(paths.plist)) return false;
  launchctl('bootout', `gui/${process.getuid?.() ?? 0}`, paths.plist);
  return true;
}

/** 备份恢复用：按既有 plist 重新拉起（bootstrap 已加载时静默、kickstart 兜底保证运行）。未安装返回 false。 */
export function startServiceAfterRestore(): boolean {
  const paths = servicePaths();
  if (!existsSync(paths.plist)) return false;
  const domain = `gui/${process.getuid?.() ?? 0}`;
  launchctl('bootstrap', domain, paths.plist);
  launchctl('kickstart', '-k', `${domain}/${launchAgentLabel()}`);
  return true;
}

export function readServiceLogs(lines = 100): Record<string, unknown> {
  const paths = servicePaths();
  const tail = (path: string) => {
    if (!existsSync(path)) return '';
    return readFileSync(path, 'utf8').split('\n').slice(-Math.min(1000, Math.max(1, lines))).join('\n');
  };
  return { stdout: tail(paths.stdout), stderr: tail(paths.stderr), paths };
}
