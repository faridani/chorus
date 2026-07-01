# Running Chorus

Chorus is a monorepo: a TypeScript daemon (`packages/*`) plus a React/Vite
dashboard (`apps/dashboard`). One long-lived daemon owns orchestration, backend
CLI runs, git worktrees, GitHub PR creation, and dashboard/API serving.

The top-level [README](../README.md) is the platform-by-platform install guide.
This document records the runtime details operators usually need after choosing
container or bare-metal mode.

## Recommended Runtime

Container mode is strongly recommended. Chorus intentionally drives AI CLIs with
dangerous approval-bypass modes for unattended engineering work:

- Codex: `codex exec --dangerously-bypass-approvals-and-sandbox`
- Claude Code: `--permission-mode bypassPermissions`
- Gemini CLI: `--approval-mode yolo`

Containers keep that process tree away from the host filesystem while mounting
only the Chorus data directory and the BYOAI/GitHub credential home you choose.
Bare-metal mode is supported, but should be limited to a dedicated machine, VM,
or OS account.

## Prerequisites

For all modes:

- A GitHub account with push + PR access to target repos.
- `gh` authenticated for that account.
- At least one BYOAI backend account: Codex, Claude Code, or Gemini CLI.

For container mode:

- macOS: Apple `container`.
- Linux: Docker or Podman.
- Windows: Docker Desktop or Podman Desktop with Linux containers enabled.

For bare-metal mode:

- Node 22+ and npm 10+.
- Git and GitHub CLI.
- The AI CLI packages you want to use:

```bash
npm install -g @openai/codex@latest @anthropic-ai/claude-code@latest @google/gemini-cli@latest
```

## Container Quick Start

```bash
# macOS
./deploy/mac/run-container.sh start

# Linux
./deploy/linux/run-container.sh start
```

```powershell
# Windows PowerShell
.\deploy\windows\run-container.ps1 start
```

Then authenticate inside the container:

```bash
gh auth login
codex login
# Also run claude/gemini once if you want those backends available.
```

The launchers publish the dashboard on <http://127.0.0.1:7878>. The daemon binds
to `0.0.0.0` inside the container, but the host port is loopback-only by default.

Useful actions:

```text
start     Build the image and start a fresh container.
restart   Same as start.
shell     Open an interactive shell inside the running container.
logs      Follow daemon logs.
stop      Stop the container.
rm        Remove the container.
status    Show runtime status.
```

## Bare-Metal Quick Start

```bash
cp chorus.config.example.json chorus.config.json
npm install
npm run build
npm --workspace @chorus/dashboard run build
node packages/daemon/dist/main.js
```

Open <http://127.0.0.1:7878>.

Before using agents, authenticate the host tools:

```bash
gh auth login
codex login
# Also run claude/gemini once if you want those backends available.
```

Bare-metal mode runs agent CLIs as your host user. Keep `host` set to
`127.0.0.1` unless the dashboard is protected by a trusted private network or
authenticated reverse proxy.

## Configuration

Copy the example and edit it:

```bash
cp chorus.config.example.json chorus.config.json
```

The daemon auto-loads `chorus.config.json` from the repo root on every start.
Set `CHORUS_CONFIG=/path/to/file.json` only if you keep config elsewhere.

Important fields:

| field | meaning |
|---|---|
| `dataDir` | SQLite DB, clones, worktrees, and logs. Bare-metal default is `~/.chorus`; container launchers force `/var/lib/chorus` inside the container. |
| `port` / `host` | Dashboard/API bind. Code defaults to `0.0.0.0:7878` when no config/env is present; the example config uses `127.0.0.1`, and container launchers publish only `127.0.0.1:7878` on the host. |
| `maxConcurrentAgents` | Parallel agent runs. |
| `agent.model` | Default Codex model override. Empty means CLI default. |
| `agent.autoUpdateCli` | Self-update Codex/Claude CLIs once per daemon process. |
| `quota.exhaustionPatterns` | Regexes that classify quota/rate-limit exhaustion. |
| `notifications.imessageTo` | macOS iMessage recipient for PR/merge notifications. |
| `terminal.allowRemoteClients` | Allows the dashboard terminal from non-local clients. Enable only on trusted networks because the dashboard is unauthenticated. |

Environment overrides:

```text
CHORUS_CONFIG
CHORUS_DATA_DIR
CHORUS_PORT
CHORUS_HOST
CHORUS_DASHBOARD_DIR
CHORUS_ALLOW_REMOTE_TERMINAL
```

## Backend CLIs

Chorus detects installed backend CLIs at startup and exposes them in the
dashboard. The implemented adapters are:

- `codex`
- `claude`
- `gemini`

Container images install those CLIs unless `CHORUS_INSTALL_AI_CLIS=false` is set
for the build. Credentials are stored in the mounted container home, so login
survives rebuilds.

## Using Chorus

1. Open <http://127.0.0.1:7878>.
2. Click **New project**.
3. Paste a GitHub repo URL.
4. Chorus clones the repo and finds or asks for `docs/SPEC.md`.
5. Chorus generates tickets and dispatches role-based agents.
6. Agents work in per-ticket worktrees and branches.
7. Chorus pushes completed ticket branches and opens GitHub PRs.
8. A human reviews and merges on GitHub. Chorus never merges to `main` itself.

## 24/7 macOS Bare-Metal Service

Edit `deploy/com.chorus.daemon.plist` paths, then:

```bash
cp deploy/com.chorus.daemon.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.chorus.daemon.plist
```

`KeepAlive` restarts the daemon on crash; boot reconciliation resumes interrupted
work from SQLite and git state.

## Remote Access

The dashboard/API has no built-in authentication. Prefer loopback plus a private
overlay or authenticated proxy. For Tailscale:

```bash
tailscale serve --bg 7878
```

If opening the dashboard from another device, set `terminal.allowRemoteClients`
only when the network is trusted and you accept exposing the interactive terminal
to clients that can reach the dashboard.

## Safety Model

- Agent CLIs run with approval bypasses. Container mode limits host exposure;
  bare-metal mode does not.
- Agents work in isolated git worktrees on per-ticket branches cut from
  `origin/<base>`, never directly on `main`.
- A local pre-push hook blocks pushes to `main`/`master`/base.
- Chorus, not the agent, pushes ticket branches and opens PRs.
- Merging a PR is always a manual human action on GitHub.

## Tests

```bash
npm test
python3 -m unittest discover -s tests
```
