'use strict';
// Shared helpers for the hooks, actions and popups.

const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// Prefix on the label of a pane whose command is kept. It shows the pane is kept, and is how the
// startup hook finds the pane again: herdr persists pane labels across restarts.
const KEEP_PREFIX = '↻ ';

const DEFAULTS = {
  // Agent labels (as herdr reports them) that may be prompted after a restart.
  agents: ['claude', 'codex'],
  // Final statuses that mean "interrupted mid-task". A blocked agent was waiting for approval;
  // that request is lost on restart, so it also needs to pick the task back up.
  interruptedStatuses: ['working', 'blocked'],
  resumePrompt:
    '[auto-resume] This session was cut off by a restart while you were working (last activity around {time}). ' +
    'Anything that was running then, such as commands, servers, builds or background processes you started, was stopped ' +
    'and may have left partial output. Check the current state first, restart any background processes you still need, ' +
    'then continue the task. If the task was already finished, say so and stop.',
  // What to do with sessions that were idle: "check-in" asks them to restore their own background
  // work (servers, monitors, scheduled wake-ups); "skip" leaves them alone.
  idleSessions: 'check-in',
  // Only check in with idle sessions active within this many hours. 0 means no limit.
  idleCheckinWithinHours: 24,
  checkinPrompt:
    '[auto-resume] The machine restarted (your last activity was around {time}). Anything you had running in the ' +
    'background, such as servers, watchers, monitors or scheduled wake-ups, was stopped. If you had any, check them and ' +
    'restart the ones you still need, then go back to waiting as before. If you had nothing running in the background, ' +
    'reply "nothing to restore" and stop. Do not start new work.',
  // How long the startup hook waits for herdr to resume a session. herdr resumes agents only after
  // a client attaches, so this also covers a short delay before the first client.
  agentReadyTimeoutSec: 300,
  // Pause between a resumed agent turning idle and sending it a prompt.
  settleSeconds: 3,
  // Records of sessions with no activity for this many days are deleted.
  recordRetentionDays: 14,
  services: [],
};

const HERDR = process.env.HERDR_BIN_PATH || 'herdr';

// Run the herdr CLI and parse its JSON output. Plugin commands inherit HERDR_SOCKET_PATH, so the
// CLI talks to the server that started them, including named sessions.
function herdr(args, { allowError = false } = {}) {
  let out;
  try {
    out = execFileSync(HERDR, args, {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120000,
    });
  } catch (err) {
    out = `${err.stdout || ''}${err.stderr || ''}`;
    if (!allowError) throw new Error(`herdr ${args.slice(0, 2).join(' ')} failed: ${out.trim() || err.message}`);
  }
  try {
    return JSON.parse(out);
  } catch {
    return { raw: out.trim() };
  }
}

function notify(title, body) {
  herdr(['notification', 'show', title, ...(body ? ['--body', body] : [])], { allowError: true });
}

// The plugin state and config directories are shared by every herdr session, so state is kept per
// session and each service names the session it belongs to.
function sessionKey(socketPath = process.env.HERDR_SOCKET_PATH || '') {
  const m = socketPath.replace(/\\/g, '/').match(/\/sessions\/([^/]+)\/[^/]+$/);
  return m ? m[1] : 'default';
}

// Identifies the current server run. herdr creates its socket file anew each time a server starts.
// Use the modification time, not the creation time: NTFS "file tunneling" gives a file recreated
// under the same name within seconds the creation time of the file it replaces.
function bootId(socketPath = process.env.HERDR_SOCKET_PATH) {
  try {
    const st = fs.statSync(socketPath);
    return String(Math.round(st.mtimeMs || st.ctimeMs));
  } catch {
    return 'unknown';
  }
}

function stateDir() {
  const base = process.env.HERDR_PLUGIN_STATE_DIR;
  if (!base) throw new Error('HERDR_PLUGIN_STATE_DIR is not set; run this from herdr');
  return path.join(base, sessionKey());
}

const agentsDir = () => path.join(stateDir(), 'agents');
const freshMarker = () => path.join(stateDir(), 'fresh-start');

function recordFile(agent, sessionId) {
  const id = crypto.createHash('sha1').update(`${agent}:${sessionId}`).digest('hex').slice(0, 16);
  return path.join(agentsDir(), `${agent}-${id}.json`);
}

function readRecords() {
  const dir = agentsDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ file: path.join(dir, f), rec: readJson(path.join(dir, f)) }))
    .filter((r) => r.rec);
}

function log(message) {
  const line = `${new Date().toISOString()} ${message}`;
  console.log(line);
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.appendFileSync(path.join(stateDir(), 'autoresume.log'), line + '\n');
  } catch {}
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Write via a temporary file and rename, so a reader never sees a half-written file.
function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      // Windows refuses to replace a file another process has open; retry briefly.
      if (attempt >= 10) {
        fs.rmSync(tmp, { force: true });
        throw err;
      }
      sleepSync(50);
    }
  }
}

function configPath() {
  const dir = process.env.HERDR_PLUGIN_CONFIG_DIR;
  if (!dir) throw new Error('HERDR_PLUGIN_CONFIG_DIR is not set; run this from herdr');
  return path.join(dir, 'config.json');
}

const readUserConfig = () => readJson(configPath()) || {};
const writeUserConfig = (cfg) => writeJsonAtomic(configPath(), cfg);
const loadConfig = () => ({ ...DEFAULTS, ...readUserConfig() });

// Write every setting missing from config.json with its default, so the file shows all settings in
// effect. Values already in the file are kept; a setting added in a later version appears with its
// default. Returns true if the file changed.
function seedConfig() {
  const user = readUserConfig();
  if (Object.keys(DEFAULTS).every((k) => k in user)) return false;
  const merged = {};
  for (const k of Object.keys(DEFAULTS)) merged[k] = k in user ? user[k] : DEFAULTS[k];
  for (const k of Object.keys(user)) if (!(k in merged)) merged[k] = user[k];
  writeUserConfig(merged);
  return true;
}
const serviceSession = (svc) => svc.session || 'default';

// Name of the shell a pane runs, to quote a captured command for it.
function shellKind(pid) {
  if (process.platform !== 'win32') return 'posix';
  try {
    const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
    const name = ((out.match(/^"([^"]+)"/m) || [])[1] || '').toLowerCase();
    return name === 'cmd.exe' ? 'cmd' : 'powershell';
  } catch {
    return 'powershell';
  }
}

// Turn a captured argv back into a command line the pane's shell runs as-is. PowerShell does not run
// a quoted path without the call operator, so PowerShell commands start with `&`.
function commandLine(argv, kind) {
  if (kind === 'powershell') {
    const quote = (a) => `'${a.replace(/'/g, "''")}'`;
    const arg = (a) => (/^[A-Za-z0-9_\-.:\/\\=+]+$/.test(a) ? a : quote(a));
    return ['&', quote(argv[0]), ...argv.slice(1).map(arg)].join(' ');
  }
  if (kind === 'cmd') {
    return argv.map((a) => (/[\s&|<>^"]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a)).join(' ');
  }
  return argv.map((a) => (/^[A-Za-z0-9_\-.,:\/=@%+]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ');
}

function processCommandLines() {
  try {
    return process.platform === 'win32'
      ? execFileSync(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { $_.CommandLine }'],
          { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 }
        )
      : execFileSync('ps', ['-eo', 'args='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return '';
  }
}

const isProcessRunning = (fragment) => processCommandLines().toLowerCase().includes(fragment.toLowerCase());

// Split a Windows command line into argv the way the C runtime does: backslashes are literal
// unless they precede a quote.
function splitWindowsCommandLine(s) {
  const args = [];
  let cur = '';
  let quoted = false;
  let started = false;
  for (let i = 0; i < s.length; ) {
    if (s[i] === '\\') {
      let n = 0;
      while (s[i] === '\\') { n++; i++; }
      if (s[i] === '"') {
        cur += '\\'.repeat(n >> 1);
        if (n % 2) { cur += '"'; i++; }
      } else cur += '\\'.repeat(n);
      started = true;
    } else if (s[i] === '"') {
      quoted = !quoted; started = true; i++;
    } else if (!quoted && (s[i] === ' ' || s[i] === '\t')) {
      if (started) { args.push(cur); cur = ''; started = false; }
      i++;
    } else {
      cur += s[i++]; started = true;
    }
  }
  if (started) args.push(cur);
  return args;
}

// The oldest child process of a pane's shell, as { argv, cmdline, cwd? }.
function oldestChild(shellPid) {
  try {
    if (process.platform === 'win32') {
      const script =
        `Get-CimInstance Win32_Process -Filter 'ParentProcessId=${Number(shellPid)}' | ` +
        `Where-Object { $_.Name -notin 'conhost.exe','OpenConsole.exe' } | Sort-Object CreationDate | ` +
        `Select-Object -First 1 CommandLine | ConvertTo-Json -Compress`;
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true }).trim();
      const cmdline = out && JSON.parse(out).CommandLine;
      return cmdline ? { argv: splitWindowsCommandLine(cmdline), cmdline } : null;
    }
    const rows = execFileSync('ps', ['-eo', 'pid=,ppid=,args='], { encoding: 'utf8' })
      .split('\n')
      .map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
      .filter((m) => m && Number(m[2]) === Number(shellPid));
    if (rows.length === 0) return null;
    const pid = Math.min(...rows.map((m) => Number(m[1]))); // lowest pid as the oldest, a heuristic
    const row = rows.find((m) => Number(m[1]) === pid);
    let argv = row[3].split(/\s+/);
    let cwd;
    try {
      argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean); // exact argv on Linux
      cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
    } catch {}
    return { argv, cmdline: row[3], cwd };
  } catch {
    return null;
  }
}

// The program running in a pane: herdr's foreground process when it reports one besides the shell,
// else the shell's oldest child (herdr on Windows reports only the shell for ordinary programs).
// Returns { argv, cmdline, cwd, shellPid } or null when only the shell is running.
function paneProgram(paneId) {
  const info = herdr(['pane', 'process-info', '--pane', paneId], { allowError: true }).result?.process_info;
  if (!info) return null;
  const fg = (info.foreground_processes || []).find((p) => p.pid !== info.shell_pid);
  if (fg) {
    return { argv: fg.argv && fg.argv.length ? fg.argv : [fg.argv0 || fg.name], cmdline: fg.cmdline, cwd: fg.cwd, shellPid: info.shell_pid };
  }
  const child = info.shell_pid ? oldestChild(info.shell_pid) : null;
  return child ? { ...child, shellPid: info.shell_pid } : null;
}

// "14:05" for today, "2026-10-14 22:05" otherwise.
function formatTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'unknown';
  const pad = (n) => String(n).padStart(2, '0');
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.toDateString() === new Date().toDateString()
    ? hm
    : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

module.exports = {
  DEFAULTS,
  KEEP_PREFIX,
  agentsDir,
  bootId,
  commandLine,
  formatTime,
  freshMarker,
  herdr,
  isProcessRunning,
  loadConfig,
  log,
  notify,
  paneProgram,
  readJson,
  readRecords,
  readUserConfig,
  recordFile,
  seedConfig,
  serviceSession,
  sessionKey,
  shellKind,
  sleep,
  stateDir,
  writeJsonAtomic,
  writeUserConfig,
};
