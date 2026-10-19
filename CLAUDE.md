# Herdr Autoresume: notes for agents

A [herdr](https://herdr.dev) plugin, id `seankao31.herdr-autoresume`. Node.js, no dependencies, no build step. `README.md` is the user-facing description; this file is how it works and how to work on it.

## Layout

| File | Role |
| --- | --- |
| `herdr-plugin.toml` | Manifest: startup hook, event hooks (`pane.agent_status_changed`; `pane.closed`, `pane.exited`, `tab.closed`, `workspace.closed`), 4 actions, 2 popup panes |
| `src/lib.js` | Shared helpers and `DEFAULTS` (every setting); `seedConfig()` writes missing settings into `config.json` |
| `src/record.js` | Event hook: records each agent session's status, per server run |
| `src/pane-closed.js` | Event hook: stops keeping a kept command whose pane was closed |
| `src/startup.js` | Startup hook: reads each session's final status from the previous run, sends continue or check-in prompts, starts kept commands |
| `src/keep.js` | Action `toggle-keep` |
| `src/ui-kept.js`, `src/ui-stop-fresh.js` | Popups (raw-mode TTY); `src/open-popup.js` opens them from actions |
| `src/setup-keys.js` | Action `setup-keys`: adds key bindings to herdr's `config.toml` |

## How it works

- **Server run ID** (`bootId()`): the modification time of `HERDR_SOCKET_PATH`, which herdr recreates on every start. Not the creation time: NTFS file tunneling gives a file recreated under the same name within about 15 s the old file's creation time.
- **Records**: one JSON file per agent session in `<state>/<session>/agents/`. When a new run first writes a record, the previous run's final status moves to `prev`, so `startup.js` sees it whether it runs before or after herdr resumes the session. `handledTs` and `promptedAt` stop a session being prompted twice for the same activity.
- **Per-session keys**: herdr's plugin state and config directories are shared by all herdr sessions, so state is kept under the session name (`sessionKey()`, from the socket path) and each kept command has a `session` field.
- **Prompting**: herdr resumes agents only after a client attaches. `startup.js` waits up to `agentReadyTimeoutSec` for each session to be `idle` or `done`, then runs `herdr agent prompt --wait --until working`, retrying once on `agent_prompt_stalled`.
- **Kept commands**: the pane is found by its label `↻ <label>` (herdr persists pane labels), else a tab with the label, else a new tab. The command is captured with `herdr pane process-info`. On Windows that reports only the shell for ordinary programs, so `paneProgram()` falls back to the shell's oldest child process (CIM on Windows, `/proc` or `ps` elsewhere). `commandLine()` re-quotes for the pane's shell; PowerShell needs the `&` call operator.
- **Closing a kept pane stops keeping it**, always, not as a setting. Stopping the program while the pane stays open does not, so a crash or Ctrl+C keeps it. The close events carry only ids, and the panes are gone when the hook runs, so `<state>/<session>/kept-panes.json` records `{ label: paneId }` for the current run: `startup.js` writes it after starting kept commands, and `keep.js` adds to it. `pane-closed.js` treats a kept command as closed when neither its label nor its pane id is still in `herdr pane list`, which spares a moved pane (same label) and a renamed one (same id). A kept command with no pane in this run, for example one skipped by `skipIfRunning` whose pane was already gone, or a hand-written one, is never removed. The hook does nothing while the `fresh-start` marker exists, because "stop and start fresh" closes every workspace on purpose. Until the first startup or keep under a new install, there is no record for the current run, so a close then does nothing.
- **Stop and start fresh**: closes every workspace, writes the `fresh-start` marker and stops the server; the next startup sees the marker and does nothing. With a client attached, herdr creates one blank workspace when the last one closes, which is expected.
- **Do not infer agent state from Claude transcripts**: on resume, Claude Code appends a placeholder "No response requested." reply to an interrupted turn, so the transcript looks finished. Use herdr's agent status.

## herdr facts that matter here

- The plugin registry (`plugins.json`) is global: `plugin link`, `unlink` or `uninstall` in a named session also changes the default session.
- Right-click menus list only built-in items ([herdr#1776](https://github.com/herdrdev/herdr/issues/1776), not planned), so actions are reached by key bindings or `herdr plugin action invoke`.
- `herdr plugin pane open --placement` does not accept `popup`; a popup's placement comes from the manifest.
- Plugins, including popups, are a preview feature on Windows. Hooks run through a short-lived helper, so a hook's parent process is not the server.
- `herdr plugin install` and `herdr plugin update` need `--yes` when stdin is not interactive.
- Close events, checked on 0.9.5: closing a pane emits `pane.closed` (only `pane_id`, `workspace_id`); a shell exiting emits only `pane.exited`; closing a tab emits only `tab.closed` and closing a workspace only `workspace.closed`, with no event per pane. `server stop` emits none of them. Pane ids are not reused within a run and survive a restart along with labels.
- Raw event subscriptions on Windows use the named pipe `\\.\pipe\` + the socket path, for example `\\.\pipe\C:\Users\<user>\AppData\Roaming\herdr\herdr.sock`; subscribe with `{"method":"events.subscribe","params":{"subscriptions":[{"type":"pane.closed"}]}}`.
- herdr's own defaults use `prefix+h/j/k/l`; this plugin suggests `prefix+alt+k/s/q`, which no popular plugin uses.

## Testing

There are no automated tests; test by hand in a **named** herdr session (`herdr --session <name> …`) and delete it afterwards (`herdr session stop <name>`, `herdr session delete <name>`, then remove `<state>/<name>/` and any test entries in `config.json`). Never stop the default herdr server: it hosts live agent sessions.

Because the registry is global, the installed copy of this plugin also runs in a named session, and a local copy cannot be linked while the GitHub copy is installed. Ways to test changes:

- **Scripts directly**, against a named session's server, with the environment herdr would give them:

  ```powershell
  $env:HERDR_BIN_PATH = "$env:LOCALAPPDATA\Programs\Herdr\bin\herdr.exe"
  $env:HERDR_SOCKET_PATH = "$env:APPDATA\herdr\sessions\<name>\herdr.sock"
  $env:HERDR_PLUGIN_ID = 'seankao31.herdr-autoresume'
  $env:HERDR_PLUGIN_STATE_DIR = '<temp>\state'
  $env:HERDR_PLUGIN_CONFIG_DIR = '<temp>\config'
  node src/startup.js
  ```

  For `record.js`, also set `HERDR_PLUGIN_EVENT_JSON='{"data":{"pane_id":"w1:p1"}}'`; `pane-closed.js` ignores the event's contents. For `keep.js`, set `HERDR_PANE_ID` to the pane. For `setup-keys.js`, set `HERDR_CONFIG_PATH` to a scratch file.
- **End to end**: install the branch under test globally (`herdr plugin install seankao31/herdr-autoresume --ref dev --yes`), test, then reinstall `main`. This affects every session, so only do it with the maintainer's agreement.

A server for a named session needs Node on its `PATH`: start it with `Start-Process herdr.exe -ArgumentList '--session','<name>','server' -WindowStyle Hidden`, and attach a client (`wt -w new new-tab herdr.exe --session <name>`) when agents need to resume.

## Workflow

- Work on `dev`. Merge into `main` only once tested: installs without `--ref` follow `main`, and this plugin prompts agents with nobody watching.
- Release: set `version` in `herdr-plugin.toml`, merge to `main`, tag `vX.Y.Z`, and create a GitHub release.
- Keep `README.md` user-facing and short: what it does and how to use it, without the reasoning or implementation details. Those belong here.

## Known gaps

- Linux and macOS are untested. The child-process lookup there uses the lowest PID as "oldest", a heuristic.
- Each check-in costs an agent turn on a resumed, uncached conversation; `idleCheckinWithinHours` limits how many sessions get one.
- Whether an idle session had background work cannot be detected reliably, which is why idle sessions are asked rather than inspected.
