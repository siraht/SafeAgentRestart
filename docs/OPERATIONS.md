# Operations

## Supported Agents

SafeAgentRestart currently recognizes:

- Codex
- Claude Code
- OpenCode

OpenCode does not expose a yolo/bypass flag in local help. SafeAgentRestart generates its `--session` and `--continue` resume syntax, but it does not add any permission-bypass option.

## Conservative Restart Policy

The project separates observation from mutation:

1. `update-plan` detects installed CLIs and prints update/reinstall commands.
2. `inventory` reads tmux pane metadata and process trees.
3. `capture` reads scrollback and writes files.
4. `plan` reads scrollback and prints candidate resume commands.
5. Human operators perform updates, quit, and resume actions manually.

This keeps accidental restarts out of scheduled jobs and agent automation.

## Recommended Full Workflow

First, update the agent CLIs before touching live panes:

```bash
bun src/safe-agent-restart.ts update-plan --text
```

Run the printed update commands. On this machine, the expected commands are:

```bash
codex update
claude update
opencode upgrade --method bun
```

Claude Code also exposes this force reinstall fallback for unhealthy native installs:

```bash
claude install stable --force
```

Then process one pane at a time:

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
