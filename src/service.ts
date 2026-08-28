import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDir } from './store.js';

export const LAUNCH_AGENT_LABEL = 'cn.csm-agent.service';

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function servicePaths(): { plist: string; stdout: string; stderr: string; cli: string } {
  const logs = join(dataDir(), 'logs');
  const siblingCli = fileURLToPath(new URL('./cli.js', import.meta.url));
  const builtCli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  return {
    plist: join(homedir(), 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`),
    stdout: join(logs, 'service.log'),
    stderr: join(logs, 'service.error.log'),
    cli: existsSync(siblingCli) ? siblingCli : builtCli,
  };
}

export function renderLaunchAgent(port = 3210): string {
  const paths = servicePaths();
  const args = [process.execPath, paths.cli, 'serve', String(port)];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>${args.map((arg) => `\n    <string>${escapeXml(arg)}</string>`).join('')}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CSM_SUPERVISED</key><string>1</string>
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
  const result = launchctl('print', `${domain}/${LAUNCH_AGENT_LABEL}`);
  return { installed: existsSync(servicePaths().plist), running: result.status === 0,
    detail: (result.stdout || result.stderr).trim().slice(0, 4000), ...servicePaths() };
}

export function restartService(): Record<string, unknown> {
  const domain = `gui/${process.getuid?.() ?? 0}`;
  const result = launchctl('kickstart', '-k', `${domain}/${LAUNCH_AGENT_LABEL}`);
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

export function readServiceLogs(lines = 100): Record<string, unknown> {
  const paths = servicePaths();
  const tail = (path: string) => {
    if (!existsSync(path)) return '';
    return readFileSync(path, 'utf8').split('\n').slice(-Math.min(1000, Math.max(1, lines))).join('\n');
  };
  return { stdout: tail(paths.stdout), stderr: tail(paths.stderr), paths };
}
