'use strict';
// Popup: list the kept commands of this herdr session; enable, disable or delete them.

const {
  KEEP_PREFIX,
  herdr,
  paneProgram,
  readUserConfig,
  seedConfig,
  serviceSession,
  sessionKey,
  writeUserConfig,
} = require('./lib');

const session = sessionKey();
let selected = 0;
let confirmDelete = false;
let items = [];

function load() {
  const panes = herdr(['pane', 'list'], { allowError: true }).result?.panes || [];
  items = (readUserConfig().services || [])
    .filter((s) => serviceSession(s) === session)
    .map((svc) => {
      const pane = panes.find((p) => p.label === KEEP_PREFIX + svc.label);
      let state = 'no pane';
      if (svc.enabled === false) state = 'disabled';
      else if (pane) state = paneProgram(pane.pane_id) ? `running in ${pane.pane_id}` : `stopped (${pane.pane_id})`;
      return { svc, pane, state };
    });
  selected = Math.min(selected, Math.max(0, items.length - 1));
}

function save(mutate) {
  const config = readUserConfig();
  config.services = config.services || [];
  mutate(config.services);
  writeUserConfig(config);
  load();
}

function render() {
  const width = (process.stdout.columns || 80) - 2;
  const cut = (s) => (s.length > width ? s.slice(0, width - 1) + '…' : s);
  const out = ['\x1b[2J\x1b[H', ` Kept commands (herdr session: ${session})`, ''];
  if (items.length === 0) {
    out.push(' None yet. In a pane running a long-lived command, press your "keep" key', ' (prefix+alt+k by default) to keep it running across restarts.');
  }
  items.forEach(({ svc, state }, i) => {
    const mark = svc.enabled === false ? '[ ]' : '[x]';
    out.push(cut(`${i === selected ? '>' : ' '} ${mark} ${svc.label}  ·  ${state}`));
    out.push(cut(`        ${svc.command}`));
    out.push(cut(`        in ${svc.cwd}`));
  });
  out.push('');
  out.push(
    confirmDelete
      ? ` Delete ${items[selected].svc.label}? It will no longer be started after a restart. y = delete, any other key = keep`
      : ' up/down select · space enable/disable · d delete · q close'
  );
  process.stdout.write(out.join('\n'));
}

function onKey(key) {
  if (confirmDelete) {
    confirmDelete = false;
    if (key === 'y' || key === 'Y') {
      const { svc, pane } = items[selected];
      save((list) => {
        const i = list.findIndex((s) => s.label === svc.label && serviceSession(s) === session);
        if (i >= 0) list.splice(i, 1);
      });
      if (pane) herdr(['pane', 'rename', pane.pane_id, '--clear'], { allowError: true });
    }
    return render();
  }
  if (key === 'q' || key === '\x1b' || key === '\x03') return quit();
  if ((key === '\x1b[A' || key === 'k') && selected > 0) selected--;
  else if ((key === '\x1b[B' || key === 'j') && selected < items.length - 1) selected++;
  else if (key === ' ' && items[selected]) {
    const { svc } = items[selected];
    save((list) => {
      const s = list.find((x) => x.label === svc.label && serviceSession(x) === session);
      if (s) s.enabled = s.enabled === false;
    });
  } else if ((key === 'd' || key === 'D') && items[selected]) confirmDelete = true;
  render();
}

function quit() {
  process.stdout.write('\x1b[?25h\x1b[2J\x1b[H');
  process.exit(0);
}

seedConfig();
load();
process.stdout.write('\x1b[?25l');
render();
process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.on('data', onKey);
