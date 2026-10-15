# herdr-autoresume

A [herdr](https://herdr.dev) plugin that picks up work after a restart: a reboot, a crash or `herdr server stop`.

herdr already restores your layout and resumes supported agents into their conversations (`claude --resume <id>`, `codex resume <id>`, ...). The resumed agents then sit at their prompts, and anything they had running in the background is gone. This plugin closes that gap:

- **Interrupted agents continue.** While herdr runs, the plugin records each agent's status. After a restart, agents that were `working` or `blocked` are told to check the current state and continue.
- **Idle agents restore their own background work.** Recently active idle agents get a check-in: restart any servers, watchers, monitors or scheduled wake-ups you still need, or reply "nothing to restore". They are told not to start new work.
- **Kept commands restart.** Press a key in a pane running a dev server or watcher, and that command is started again in the same pane after every restart.
- **A deliberate fresh start.** One key stops herdr so the next start is empty, with nothing restored, resumed or restarted.

## Requirements

- herdr 0.9.5 or later.
- Node.js on the `PATH` that the herdr server sees. Every hook, action and popup runs `node`.
- The herdr integration for each agent, so herdr can resume its sessions: `herdr integration install claude`, `herdr integration install codex`.

## Install

```sh
herdr plugin link /path/to/herdr-autoresume
```

Then bind the actions in herdr's `config.toml`. Plugins cannot bind keys themselves; these are suggestions, chosen not to clash with herdr's defaults (`prefix+k` is herdr's "focus pane up") or with the keys popular plugins recommend:

```toml
[[keys.command]]
key = "prefix+alt+k"
type = "plugin_action"
command = "autoresume.toggle-keep"
description = "keep / stop keeping this pane's command"

[[keys.command]]
key = "prefix+alt+s"
type = "plugin_action"
command = "autoresume.kept-commands"
description = "show kept commands"

[[keys.command]]
key = "prefix+alt+q"
type = "plugin_action"
command = "autoresume.stop-fresh"
description = "stop herdr and start fresh next time"
```

Every action also runs from a shell: `herdr plugin action invoke autoresume.toggle-keep`. herdr's right-click menus list only built-in items ([herdr#1776](https://github.com/herdrdev/herdr/issues/1776)), so the actions are not in them.

## Use

| Key (suggested) | What it does |
| --- | --- |
| `prefix+alt+k` | In a pane running a long-lived command, keep it: the pane is labelled `↻ <name>` and the command starts again there after a restart. Press it again to stop keeping it. Agent panes are refused; herdr resumes agents itself. |
| `prefix+alt+s` | Popup listing this session's kept commands, whether each is running, and keys to enable, disable or delete them. |
| `prefix+alt+q` | Popup that asks for confirmation, then closes every workspace and stops the server. The next start opens one new, empty workspace and starts no kept commands. Your list of kept commands is not changed. |

Anything else that stops the server, such as a reboot, a crash or a plain `herdr server stop`, restores and resumes as usual.

After a restart, see what the plugin did in `herdr plugin log`, or in `autoresume.log` in the plugin state directory (`<HERDR_PLUGIN_STATE_DIR>/<session>/`).

## Configure

Settings and kept commands live in `config.json` in the directory printed by `herdr plugin config-dir autoresume`. The plugin writes every setting with its default into this file the first time it runs (at a herdr server start, or when you use the keep action or the kept-commands popup), so the file always shows what is in effect; edit the values there. The keep action and the popup edit the `services` list for you. Settings added in a later version of the plugin are added to the file with their defaults; a value already in the file is never changed. See [`config.example.json`](config.example.json).

| Key | Default | Meaning |
| --- | --- | --- |
| `agents` | `["claude", "codex"]` | Agent labels, as herdr reports them, that may be prompted. |
| `interruptedStatuses` | `["working", "blocked"]` | Final statuses that count as interrupted. |
| `resumePrompt` | see `src/lib.js` | Sent to interrupted agents. `{time}` becomes the time of their last activity. |
| `idleSessions` | `"check-in"` | `"check-in"` prompts recently active idle agents to restore their background work; `"skip"` leaves them alone. |
| `idleCheckinWithinHours` | `24` | Only check in with agents active within this many hours. `0` means no limit. |
| `checkinPrompt` | see `src/lib.js` | Sent to idle agents. `{time}` as above. |
| `agentReadyTimeoutSec` | `300` | How long to wait for herdr to resume a session. herdr resumes agents only after a client attaches. |
| `settleSeconds` | `3` | Pause between a resumed agent turning idle and sending the prompt. |
| `recordRetentionDays` | `14` | Status records of sessions inactive this long are deleted. |
| `services` | `[]` | Kept commands; see below. |

Each kept command has:

| Key | Meaning |
| --- | --- |
| `label` | Name. The pane labelled `↻ <label>` runs it; if there is none, a tab labelled `<label>` is used or created. |
| `cwd` | Directory. A new tab goes into a workspace that has a pane under it, or into a new workspace. |
| `command` | Command line typed into the pane's shell. |
| `session` | herdr session it belongs to. Default: `default`. |
| `skipIfRunning` | Optional. Not started if any process command line contains this text. The keep action sets it to the exact command line, so a copy already running outside herdr is not started twice. |
| `enabled` | `false` keeps the entry without starting it. |

## How it works

| Hook | Script | What it does |
| --- | --- | --- |
| `pane.agent_status_changed` event | `src/record.js` | For agents with a native session reference, records the status, tagged with the server run. When a new run first touches a record, the old run's final status is kept. |
| `startup` | `src/startup.js` | Reads each session's final status from the previous run, starts kept commands, waits for herdr to resume each session, then sends the continue or check-in prompt with `herdr agent prompt`. |

A server run is identified by the modification time of herdr's socket file, which herdr recreates on every start. Each final status is acted on once.

A kept command is captured from `herdr pane process-info`. On Windows, herdr reports only the shell for ordinary programs, so the plugin falls back to the shell's oldest child process. Commands are re-quoted for the pane's shell; PowerShell commands start with `&`.

## Starting herdr when the machine starts

The plugin acts when the herdr server starts, and herdr resumes agents once a client attaches. To get both after an unattended reboot, start a herdr client at login.

- **Windows:** add a Windows Terminal profile whose command line is `%LOCALAPPDATA%\Programs\Herdr\bin\herdr.exe`, and open herdr from that profile. Turn on Terminal's **Launch on machine startup** and **When Terminal starts: Open windows from a previous session**. Terminal then reopens the herdr tab at sign-in, and Windows signs in automatically after an update restart unless that option is off. Node.js must be on the user or system `PATH`, not only added by a shell profile.

## Limitations

- Prompts are sent with nobody watching, and agents act on them. Only agents in `agents` are prompted, only after herdr has resumed them, and idle agents are told not to start new work.
- Each check-in is one agent turn on a resumed session, which re-reads its whole conversation. `idleCheckinWithinHours` bounds how many sessions this applies to.
- Status comes from herdr's agent detection. An agent herdr cannot classify is not prompted.
- Anything running when the machine went down is gone; the prompts ask agents to check the current state first.
- herdr's plugin API is marked early, and plugins, including popups, are a preview feature on Windows.

## Related plugins

- [herdr-continue](https://github.com/codergeek121/herdr-continue) sends `continue` to every idle agent at startup, whether or not it was mid-task. Linux and macOS.
- [herdr-resurrect](https://github.com/ntindle/herdr-resurrect) snapshots and re-runs the programs in all panes, filtered by an allowlist, instead of the commands you choose to keep.
- [herdr-pane-restart](https://github.com/zap0xfce2/herdr-pane-restart) re-runs commands listed in its config in named panes. Linux and macOS.
