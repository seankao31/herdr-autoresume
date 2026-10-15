'use strict';
// Action: keep the focused pane's command running across restarts, or stop keeping it.

const path = require('node:path');
const {
  KEEP_PREFIX,
  commandLine,
  herdr,
  notify,
  paneProgram,
  readUserConfig,
  seedConfig,
  serviceSession,
  sessionKey,
  shellKind,
  writeUserConfig,
} = require('./lib');

function focusedPaneId() {
  if (process.env.HERDR_PANE_ID) return process.env.HERDR_PANE_ID;
  try {
    const ctx = JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON || '{}');
    return ctx.pane_id || (ctx.pane && ctx.pane.pane_id) || null;
  } catch {
    return null;
  }
}

// A short name for the command: its script or file argument if it has one, else the program name.
function nameFor(argv) {
  const base = (s) => path.basename(String(s).replace(/\\/g, '/'));
  const file = argv.slice(1).find((a) => !a.startsWith('-') && /[\\/.]/.test(a) && !/^[\d.:]+$/.test(a));
  return file ? base(file) : base(argv[0]).replace(/\.exe$/i, '').toLowerCase();
}

function main() {
  const paneId = focusedPaneId();
  if (!paneId) return notify('Auto-resume', 'No focused pane.');
  const pane = herdr(['pane', 'get', paneId]).result.pane;
  seedConfig();
  const config = readUserConfig();
  const services = config.services || [];
  const session = sessionKey();

  // Already kept: stop keeping it.
  if (pane.label && pane.label.startsWith(KEEP_PREFIX)) {
    const label = pane.label.slice(KEEP_PREFIX.length);
    config.services = services.filter((s) => !(s.label === label && serviceSession(s) === session));
    writeUserConfig(config);
    herdr(['pane', 'rename', paneId, '--clear'], { allowError: true });
    return notify(`Stopped keeping ${label}`, 'It will not be started again after a restart.');
  }

  if (pane.agent) {
    return notify('Nothing to keep', `This pane runs ${pane.agent}. herdr already resumes agents after a restart.`);
  }
  const proc = paneProgram(paneId);
  if (!proc) {
    return notify('Nothing to keep', 'No program is running in this pane. Start it, then press the key again.');
  }

  const argv = proc.argv;
  const command = commandLine(argv, shellKind(proc.shellPid));
  const taken = new Set(services.filter((s) => serviceSession(s) === session).map((s) => s.label));
  let label = nameFor(argv);
  for (let n = 2; taken.has(label); n++) label = `${nameFor(argv)}-${n}`;

  services.push({
    label,
    session,
    cwd: proc.cwd || pane.cwd,
    command,
    // Not started after a restart if this exact command is already running outside herdr.
    skipIfRunning: proc.cmdline || argv.join(' '),
  });
  config.services = services;
  writeUserConfig(config);
  herdr(['pane', 'rename', paneId, KEEP_PREFIX + label], { allowError: true });
  notify(`Keeping ${label}`, `It will be started again here after herdr restarts: ${command}`);
}

try {
  main();
} catch (err) {
  notify('Auto-resume: keep failed', err.message);
  process.exitCode = 1;
}
