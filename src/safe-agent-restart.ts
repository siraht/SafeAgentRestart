#!/usr/bin/env bun

function main(): void {
  console.log(JSON.stringify({ ok: true, command: "safe-agent-restart", status: "scaffold" }, null, 2));
}

main();
