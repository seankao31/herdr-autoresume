'use strict';
// Event hook for pane.closed, pane.exited, tab.closed and workspace.closed: a kept command whose pane
// was closed is no longer kept.
//
// The events name only the closed pane, tab or workspace, and the panes are gone by the time this
// runs, so compare the panes kept commands were in during this run with the panes that are left.

const fs = require('node:fs');
const {
  KEEP_PREFIX,
  freshMarker,
  herdr,
  log,
  notify,
  readKeptPanes,
  readUserConfig,
  serviceSession,
  sessionKey,
  writeKeptPanes,
  writeUserConfig,
} = require('./lib');

function main() {
  // "Stop and start fresh" closes every workspace, but the kept commands stay kept.
  if (fs.existsSync(freshMarker())) return;
  const kept = readKeptPanes();
  if (Object.keys(kept).length === 0) return;

  const panes = herdr(['pane', 'list'], { allowError: true }).result?.panes;
  if (!panes) return; // the server did not answer
  const labels = new Set(panes.map((p) => p.label));
  const ids = new Set(panes.map((p) => p.pane_id));
  // A moved pane keeps its label and a renamed one keeps its id, so a pane is gone only if both are.
  const gone = Object.keys(kept).filter((label) => !labels.has(KEEP_PREFIX + label) && !ids.has(kept[label]));
  if (gone.length === 0) return;

  // Read and write right after each other, so hooks for panes closed together do not undo each other.
  const session = sessionKey();
  const isGone = (s) => gone.includes(s.label) && serviceSession(s) === session;
  const config = readUserConfig();
  const removed = (config.services || []).filter(isGone).map((s) => s.label);
  if (removed.length > 0) {
    config.services = config.services.filter((s) => !isGone(s));
    writeUserConfig(config);
  }
  const left = readKeptPanes();
  for (const label of gone) delete left[label];
  writeKeptPanes(left);

  if (removed.length === 0) return;
  log(`kept command ${removed.join(', ')}: pane closed, no longer kept`);
  notify(
    `Stopped keeping ${removed.join(', ')}`,
    `${removed.length === 1 ? 'Its pane was closed, so it' : 'Their panes were closed, so they'} will not be started again after a restart.`
  );
}

try {
  main();
} catch (err) {
  log(`pane-closed hook: ${err.message}`);
  process.exitCode = 1;
}
