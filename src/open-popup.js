'use strict';
// Action helper: open one of this plugin's popups (its placement comes from the manifest).
// Actions can be bound to keys and invoked from the CLI; pane entrypoints alone cannot.

const { herdr, notify } = require('./lib');

const entrypoint = process.argv[2];
const res = herdr(['plugin', 'pane', 'open', '--plugin', process.env.HERDR_PLUGIN_ID, '--entrypoint', entrypoint], {
  allowError: true,
});
if (res.error) {
  notify('Auto-resume', `Could not open ${entrypoint}: ${res.error.message || res.error.code}`);
  process.exitCode = 1;
}
