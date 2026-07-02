# SafeAgentRestart

Dry-run-first tooling for safely restarting and resuming tmux-hosted Codex and Claude Code agents.

SafeAgentRestart inventories tmux panes, captures scrollback, extracts visible session IDs, and prints the resume command that should be used after a manual graceful quit. It is built for long-running NTM/tmux workstations where agent panes may be days or weeks old.

## Safety Model

This tool does **not**:

- send keys to panes
- quit agents
- kill processes
- respawn tmux panes
- run `codex resume` or `claude --resume`

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

Inventory live agent panes:

```bash
bun src/safe-agent-restart.ts inventory --text
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
