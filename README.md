# SafeAgentRestart

Dry-run-first tooling for safely restarting and resuming tmux-hosted Codex, Claude Code, and OpenCode agents.

SafeAgentRestart inventories tmux panes, detects agent CLI update commands, captures scrollback, extracts visible session IDs, and prints the resume command that should be used after a manual graceful quit. It is built for long-running NTM/tmux workstations where agent panes may be days or weeks old.

## Safety Model

This tool does **not**:

- send keys to panes
- quit agents
- kill processes
- respawn tmux panes
- run CLI updates, reinstalls, or resume commands

It only reads tmux/process state and writes optional capture files.

## Install

```bash
bun install
```

Run from the project checkout:

```bash
bun src/safe-agent-restart.ts --help
```

Or install/link it using your preferred Bun workflow.

## Commands

Detect the installed agent CLI update commands:

```bash
bun src/safe-agent-restart.ts update-plan --text
```

Inventory live agent panes:

```bash
bun src/safe-agent-restart.ts inventory --text
```

Check whether detected agent panes look safely between turns:

```bash
bun src/safe-agent-restart.ts readiness --text
```

Capture scrollback for all detected agent panes:

```bash
bun src/safe-agent-restart.ts capture --output-dir .safe-agent-restart
```

Build a restart/resume plan:

```bash
bun src/safe-agent-restart.ts plan --text
```

Limit to one tmux session or pane:

```bash
bun src/safe-agent-restart.ts plan --session cashfirst --text
bun src/safe-agent-restart.ts plan --pane 'cashfirst:1.4' --text
```

Print the manual restart sequence:

```bash
bun src/safe-agent-restart.ts sequence
```

## Resume Syntax

Codex:

```bash
codex --dangerously-bypass-approvals-and-sandbox resume <session-id>
codex --dangerously-bypass-approvals-and-sandbox resume --last
```

Claude Code:

```bash
claude --dangerously-skip-permissions --resume <session-id>
claude --dangerously-skip-permissions --continue
```

OpenCode:

```bash
opencode --session <session-id>
opencode --continue
```

## Turn Readiness

The agent CLIs do not currently expose a reliable cross-tool "between turns" API. SafeAgentRestart therefore uses conservative read-only heuristics:

- visible idle prompt and no active child process: `restartSafe=true`
- visible activity marker: `restartSafe=false`
- typed prompt draft, persistent child service, or no reliable prompt: `restartSafe=false`

Any future automation should only restart panes where `readiness` or `plan` reports `restartSafe=true`.

## Update Syntax

Run updates before quitting live panes. The `update-plan` command detects the install method where possible and prints the matching command. On this machine, that maps to:

```bash
codex update
claude update
opencode upgrade --method bun
```

Claude Code also exposes a force reinstall path for unhealthy native installs:

```bash
claude install stable --force
```
