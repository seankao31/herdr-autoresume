'use strict';
// Action: add key bindings for this plugin's actions to herdr's config.toml. A binding is skipped
// when its action is already bound or its key is already in use. The file is backed up first,
// validated with `herdr config check` after, and restored if the check fails.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { herdr, log, notify } = require('./lib');

const PLUGIN = process.env.HERDR_PLUGIN_ID || 'seankao31.herdr-autoresume';
const BINDINGS = [
  { key: 'prefix+alt+k', action: 'toggle-keep', description: "keep / stop keeping this pane's command" },
  { key: 'prefix+alt+s', action: 'kept-commands', description: 'show kept commands' },
  { key: 'prefix+alt+q', action: 'stop-fresh', description: 'stop herdr and start fresh next time' },
];

function configFile() {
  if (process.env.HERDR_CONFIG_PATH) return process.env.HERDR_CONFIG_PATH;
  return process.platform === 'win32'
    ? path.join(process.env.APPDATA, 'herdr', 'config.toml')
    : path.join(os.homedir(), '.config', 'herdr', 'config.toml');
}

const norm = (k) => k.toLowerCase().replace(/\s+/g, '');

// Keys bound in TOML text, mapped to what uses them. Reads `name = "key"` lines in [keys] and
// `key = "..."` lines in [[keys.command]]. With commented=true it reads herdr's commented-out
// defaults from `herdr --default-config` instead.
function boundKeys(text, commented = false) {
  const keys = new Map();
  let section = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = commented ? raw.replace(/^\s*#\s*/, '') : raw.replace(/#.*$/, '');
    const header = line.trim().match(/^\[\[?\s*([^\]]+?)\s*\]\]?$/);
    if (header) {
      section = header[1];
      continue;
    }
    if (section !== 'keys' && section !== 'keys.command') continue;
    const m = line.trim().match(/^([\w-]+)\s*=\s*"([^"]+)"/);
    if (!m || m[1] === 'prefix') continue;
    if (section === 'keys.command') {
      if (m[1] === 'key') keys.set(norm(m[2]), 'a custom command');
    } else {
      keys.set(norm(m[2]), `herdr's ${m[1]}`);
    }
  }
  return keys;
}

function main() {
  const file = configFile();
  const original = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const defaults = herdr(['--default-config'], { allowError: true }).raw || '';
  const taken = new Map([...boundKeys(defaults, true), ...boundKeys(original)]);

  const added = [];
  const skipped = [];
  for (const b of BINDINGS) {
    const command = `${PLUGIN}.${b.action}`;
    if (new RegExp(`command\\s*=\\s*"${command.replace(/\./g, '\\.')}"`).test(original)) {
      skipped.push(`${b.action} is already bound`);
    } else if (taken.has(norm(b.key))) {
      skipped.push(`${b.key} is used by ${taken.get(norm(b.key))}`);
    } else {
      added.push({ ...b, command });
    }
  }

  if (added.length === 0) {
    notify('Auto-resume: no key bindings added', skipped.join('; '));
    log(`setup-keys: nothing added (${skipped.join('; ')})`);
    return;
  }

  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const blocks = added.map((b) =>
    ['[[keys.command]]', `key = "${b.key}"`, 'type = "plugin_action"', `command = "${b.command}"`, `description = "${b.description}"`].join(eol)
  );
  const separator = original === '' ? '' : original.endsWith(eol) ? eol : eol + eol;
  const backup = `${file}.autoresume-backup`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (original !== '') fs.writeFileSync(backup, original);
  fs.writeFileSync(file, original + separator + `# Added by the ${PLUGIN} plugin. Change the keys freely.` + eol + blocks.join(eol + eol) + eol);

  const check = herdr(['config', 'check'], { allowError: true });
  const checkText = (check.raw || JSON.stringify(check)).replace(/\s+/g, ' ');
  if (!/config: ok/.test(checkText)) {
    if (original !== '') fs.writeFileSync(file, original);
    else fs.rmSync(file, { force: true });
    notify('Auto-resume: key bindings not added', `herdr rejected the change, so config.toml was restored: ${checkText.slice(0, 200)}`);
    log(`setup-keys: config check failed, restored config.toml: ${checkText}`);
    process.exitCode = 1;
    return;
  }
  herdr(['server', 'reload-config'], { allowError: true });

  const summary = added.map((b) => `${b.key}: ${b.description}`).join('; ');
  notify('Auto-resume: key bindings added', summary + (skipped.length ? `. Skipped: ${skipped.join('; ')}` : ''));
  log(`setup-keys: added ${summary}${skipped.length ? `; skipped ${skipped.join('; ')}` : ''}; backup at ${backup}`);
}

try {
  main();
} catch (err) {
  notify('Auto-resume: setup-keys failed', err.message);
  process.exitCode = 1;
}
