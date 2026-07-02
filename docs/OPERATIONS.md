# Operations

## Supported Agents

SafeAgentRestart currently recognizes:

- Codex
- Claude Code
- OpenCode, inventory only

OpenCode resume syntax is intentionally not generated yet.

## Conservative Restart Policy

The project separates observation from mutation:

1. `inventory` reads tmux pane metadata and process trees.
2. `capture` reads scrollback and writes files.
3. `plan` reads scrollback and prints candidate resume commands.
4. Human operators perform quit and resume actions manually.

This keeps accidental restarts out of scheduled jobs and agent automation.

## Recommended Full Workflow

For each pane:

```bash
bun src/safe-agent-restart.ts capture --pane '<pane>'
bun src/safe-agent-restart.ts plan --pane '<pane>' --text
tmux send-keys -t '<pane>' C-c
tmux capture-pane -p -t '<pane>' -S -5000
tmux send-keys -t '<pane>' '<resume-command>' Enter
```

Process one pane at a time. Do not bulk quit active agents unless every pane has a reviewed capture.

## Why Not `ntm respawn`

`ntm respawn` restarts panes using their existing command. That is useful for fresh agents, but it does not automatically convert a live TUI into an exact `resume <session-id>` invocation. Use SafeAgentRestart to get the resume command first.

## Exit Codes

- `0`: command completed
- `1`: invalid arguments, tmux failure, or capture failure
