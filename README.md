# Herdr Autoresume

Picks up your work after [herdr](https://herdr.dev) restarts: after a reboot, a crash or `herdr server stop`.

herdr brings back your layout and resumes agents into their conversations, but they wait at an empty prompt, and whatever ran in your panes is gone. This plugin:

- **Tells interrupted agents to continue.** Agents that were working, or waiting for approval, when herdr stopped are asked to check the current state and carry on.
- **Lets idle agents restore their background work.** Recently active idle agents are asked to restart any servers, watchers or monitors they still need, or to reply "nothing to restore". They are told not to start new work.
- **Restarts commands you keep.** Mark a pane's dev server or watcher once, and it starts again in that pane after every restart.
- **Starts fresh when you ask.** One action stops herdr so that the next start is empty.

## Requirements

- herdr 0.9.5 or later
- Node.js on the `PATH` herdr runs with, not only added by a shell profile
- herdr's integration for your agents: `herdr integration install claude`, `herdr integration install codex`

## Install

```sh
herdr plugin install seankao31/herdr-autoresume
herdr plugin action invoke seankao31.herdr-autoresume.setup-keys
```

The first command shows what the plugin will run, then installs it. The second binds the plugin's actions to the keys listed under [Use](#use), skipping any key already in use, and reloads herdr; a notification says what it added. To use other keys, change the `key` lines it added to herdr's `config.toml` (`%APPDATA%\herdr\config.toml` on Windows, `~/.config/herdr/config.toml` on Linux and macOS).

Update the plugin later with `herdr plugin update`. To stay on a release instead of following the latest changes, install with `--ref`, for example `herdr plugin install seankao31/herdr-autoresume --ref v0.1.0`.

## Start herdr at login

The plugin acts when herdr starts, and herdr resumes agents once a window is attached, so open herdr at login.

On Windows: add a Windows Terminal profile with the command line `%LOCALAPPDATA%\Programs\Herdr\bin\herdr.exe` and open herdr from it. Then turn on Terminal's **Launch on machine startup** and **When Terminal starts: Open windows from a previous session**.

## Use

| Action | Key | What it does |
| --- | --- | --- |
| Keep / stop keeping | `prefix+alt+k` | Press it in a pane running a long-lived command. The pane is labelled `↻ <name>`, and the command starts again there after a restart. Press it again to stop. Agent panes don't need it: herdr resumes agents itself. |
| Kept commands | `prefix+alt+s` | A popup to see, enable, disable or delete kept commands. |
| Stop and start fresh | `prefix+alt+q` | Asks first, then closes every workspace and stops herdr. The next start opens one empty workspace and starts no kept commands. |

Any other way herdr stops, such as a reboot, a crash or `herdr server stop`, is restored and resumed. Each action also runs from a shell, for example `herdr plugin action invoke seankao31.herdr-autoresume.toggle-keep`.

What the plugin did after a restart is logged in `autoresume.log`, in the plugin's state directory under the herdr session's name. On Windows that is `%LOCALAPPDATA%\herdr\plugins\seankao31.herdr-autoresume\default\autoresume.log`.

## Configure

Settings are in `config.json`, in the folder printed by `herdr plugin config-dir seankao31.herdr-autoresume`. The plugin fills the file with every setting and its default; edit the values there. Changes apply at the next herdr start.

| Setting | Default | Meaning |
| --- | --- | --- |
| `agents` | `["claude", "codex"]` | Agents that may be prompted. |
| `interruptedStatuses` | `["working", "blocked"]` | Statuses that count as interrupted. |
| `resumePrompt` | | Message to interrupted agents. `{time}` becomes their last activity. |
| `idleSessions` | `"check-in"` | `"check-in"` or `"skip"` for idle agents. |
| `idleCheckinWithinHours` | `24` | Only check in with agents active this recently. `0` means no limit. |
| `checkinPrompt` | | Message to idle agents. `{time}` as above. |
| `agentReadyTimeoutSec` | `300` | How long to wait for herdr to resume an agent. |
| `settleSeconds` | `3` | Pause before prompting a resumed agent. |
| `recordRetentionDays` | `14` | Forget sessions inactive for this long. |
| `services` | `[]` | Kept commands. The keep action and the popup edit this list. |

Each kept command has a `label`, the `cwd` and `command` to run, the herdr `session` it belongs to, and optionally `skipIfRunning` (text that, if found in any running process's command line, means it is already running and is not started) and `enabled`.

## Limitations

- Prompts are sent with nobody watching, and agents act on them.
- Each check-in costs one agent turn.
- Only agents that herdr can resume and recognize are prompted.
- Whatever was running when the machine went down is gone. Agents are asked to check the current state first.
- Tested on Windows with Claude Code. herdr's plugin API is early, and plugins are a preview feature on Windows.

## Similar plugins

- [herdr-continue](https://github.com/codergeek121/herdr-continue) sends `continue` to every idle agent at startup, whether or not it was mid-task.
- [herdr-resurrect](https://github.com/ntindle/herdr-resurrect) re-runs the programs in all panes, filtered by an allowlist.

## Development

Clone the repo and run `herdr plugin link <folder>`. Linked plugins run from the folder, so edits apply to the next hook or action. Changes are made on the `dev` branch and merged into `main` once tested; installs without `--ref` follow `main`.

## License

[MIT](LICENSE)
