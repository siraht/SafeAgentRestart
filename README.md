# SafeAgentRestart

Dry-run-first tooling for safely restarting and resuming tmux-hosted Codex and Claude Code agents.

This project is intentionally conservative: it inventories panes, captures scrollback, extracts resume hints, and prints restart commands. It does not quit or respawn agents unless a future explicit execution mode is added and deliberately invoked.
