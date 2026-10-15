'use strict';
// Popup: stop this herdr session and start fresh next time. Ends every workspace, so herdr has
// nothing to restore or resume, and leaves a marker so the next start skips kept commands too.
// Pass --yes to skip the confirmation (for scripts).

const fs = require('node:fs');
const { agentsDir, freshMarker, herdr, readUserConfig, serviceSession, sessionKey, stateDir } = require('./lib');

function summary() {
  const workspaces = herdr(['workspace', 'list'], { allowError: true }).result?.workspaces || [];
  const agents = herdr(['agent', 'list'], { allowError: true }).result?.agents || [];
  const working = agents.filter((a) => ['working', 'blocked'].includes(a.agent_status)).length;
  const kept = (readUserConfig().services || []).filter((s) => serviceSession(s) === sessionKey() && s.enabled !== false).length;
  return { workspaces, agents, working, kept };
}

function stopFresh(workspaces) {
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(freshMarker(), new Date().toISOString() + '\n');
  fs.rmSync(agentsDir(), { recursive: true, force: true });
  for (const ws of workspaces) herdr(['workspace', 'close', ws.workspace_id], { allowError: true });
  herdr(['server', 'stop'], { allowError: true });
}

const s = summary();
if (process.argv.includes('--yes')) {
  stopFresh(s.workspaces);
} else {
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  process.stdout.write(
    [
      '\x1b[2J\x1b[H',
      ' Stop herdr and start fresh',
      '',
      ` This ends everything in this herdr session (${sessionKey()}):`,
      `   ${plural(s.workspaces.length, 'workspace')}, ${plural(s.agents.length, 'agent')}` +
        (s.working ? ` (${s.working} mid-task)` : '') +
        `, ${plural(s.kept, 'kept command')}.`,
      '',
      ' Next time herdr starts it opens one new, empty workspace: nothing is restored',
      ' or resumed, and kept commands are not started. Your list of kept commands',
      ' stays as it is.',
      '',
      ' Press y to stop and start fresh. Any other key cancels.',
    ].join('\n')
  );
  process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdin.once('data', (key) => {
    if (key === 'y' || key === 'Y') {
      process.stdout.write('\n\n Stopping…');
      stopFresh(s.workspaces);
    }
    process.exit(0);
  });
}
