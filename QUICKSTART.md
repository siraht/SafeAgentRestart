# Quickstart

## 1. Check Agent CLI Updates

```bash
bun src/safe-agent-restart.ts update-plan --text
```

Run the printed update commands before quitting any panes. On this machine that normally means:

```bash
codex update
claude update
opencode upgrade --method bun
```

If Claude Code reports an unhealthy native install, the plan also prints the force reinstall fallback:

```bash
claude install stable --force
```

## 2. Inventory Panes

```bash
bun src/safe-agent-restart.ts inventory --text
```

Review the agent kind, process id, cwd, and current bypass mode for each detected pane.

## 3. Capture Before Touching Anything

```bash
bun src/safe-agent-restart.ts capture --pane 'cashfirst:1.4'
```

Capture files are written under `.safe-agent-restart/captures/<timestamp>/`.

## 4. Build A Plan

```bash
bun src/safe-agent-restart.ts plan --pane 'cashfirst:1.4' --text
```

If a UUID-style session ID is visible in scrollback, the plan uses it. Otherwise, it uses the safest available fallback:

- Codex: `resume --last`
- Claude Code: `--continue`
- OpenCode: `--continue`

## 5. Manual Restart

Only after reviewing the capture:

```bash
tmux send-keys -t 'cashfirst:1.4' C-c
tmux capture-pane -p -t 'cashfirst:1.4' -S -5000
```

If the post-quit output prints a better resume command, use that. Otherwise use the command from the plan.

## 6. Resume

Codex:

```bash
tmux send-keys -t 'cashfirst:1.4' 'codex --dangerously-bypass-approvals-and-sandbox resume <session-id>' Enter
```

Claude Code:

```bash
tmux send-keys -t 'cashfirst:1.2' 'claude --dangerously-skip-permissions --resume <session-id>' Enter
```

OpenCode:

```bash
tmux send-keys -t 'cashfirst:1.3' 'opencode --session <session-id>' Enter
```
