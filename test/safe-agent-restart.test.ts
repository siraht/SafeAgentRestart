import { describe, expect, test } from "bun:test";
import { assessTurnState, buildResumeCommand, detectAgent, extractSessionIds } from "../src/safe-agent-restart";

describe("detectAgent", () => {
  test("detects Codex bypass mode from a process tree", () => {
    const tree = "zsh,100 `-codex,200 --dangerously-bypass-approvals-and-sandbox resume --all";
    expect(detectAgent(tree)).toEqual({
      kind: "codex",
      rootPid: 200,
      invocation: "codex,200 --dangerously-bypass-approvals-and-sandbox resume --all",
      bypassMode: true,
    });
  });

  test("detects Claude dangerous skip permissions mode", () => {
    const tree = "zsh,100 `-claude,300 --dangerously-skip-permissions";
    expect(detectAgent(tree)).toEqual({
      kind: "claude",
      rootPid: 300,
      invocation: "claude,300 --dangerously-skip-permissions",
      bypassMode: true,
    });
  });
});

describe("extractSessionIds", () => {
  test("deduplicates UUID-style session identifiers in order", () => {
    const ids = extractSessionIds(`
      Session: 019e2398-b600-7777-aaaa-111111111111
      Resume: codex resume 019e2398-b600-7777-aaaa-111111111111
      Other: 019e2816-ca83-78e1-8c1e-222222222222
    `);
    expect(ids).toEqual([
      "019e2398-b600-7777-aaaa-111111111111",
      "019e2816-ca83-78e1-8c1e-222222222222",
    ]);
  });
});

describe("buildResumeCommand", () => {
  test("builds Codex exact and fallback resume commands", () => {
    expect(buildResumeCommand("codex", "019e2816-ca83-78e1-8c1e-222222222222")).toBe(
      "codex --dangerously-bypass-approvals-and-sandbox resume 019e2816-ca83-78e1-8c1e-222222222222",
    );
    expect(buildResumeCommand("codex", undefined)).toBe("codex --dangerously-bypass-approvals-and-sandbox resume --last");
  });

  test("builds Claude exact and fallback resume commands", () => {
    expect(buildResumeCommand("claude", "019e2816-ca83-78e1-8c1e-222222222222")).toBe(
      "claude --dangerously-skip-permissions --resume 019e2816-ca83-78e1-8c1e-222222222222",
    );
    expect(buildResumeCommand("claude", undefined)).toBe("claude --dangerously-skip-permissions --continue");
  });

  test("builds OpenCode exact and fallback resume commands", () => {
    expect(buildResumeCommand("opencode", "019e2816-ca83-78e1-8c1e-222222222222")).toBe(
      "opencode --session 019e2816-ca83-78e1-8c1e-222222222222",
    );
    expect(buildResumeCommand("opencode", undefined)).toBe("opencode --continue");
  });
});

describe("assessTurnState", () => {
  test("marks a Claude prompt with no active child process as idle", () => {
    const state = assessTurnState("claude", "✻ Worked for 0s\n\n❯ ", "claude,100 --dangerously-skip-permissions");
    expect(state.status).toBe("idle");
    expect(state.restartSafe).toBe(true);
  });

  test("marks visible Codex activity as busy", () => {
    const state = assessTurnState("codex", "gpt-5.5  Pursuing goal (5h 49m)\n› ", "codex,100 --dangerously-bypass-approvals-and-sandbox");
    expect(state.status).toBe("busy");
    expect(state.restartSafe).toBe(false);
  });

  test("marks prompt draft text as unknown to avoid losing input", () => {
    const state = assessTurnState("codex", "Conversation interrupted\n\n› Implement {feature}", "codex,100 --dangerously-bypass-approvals-and-sandbox");
    expect(state.status).toBe("unknown");
    expect(state.restartSafe).toBe(false);
  });

  test("marks active child tool processes as busy", () => {
    const state = assessTurnState(
      "codex",
      "› ",
      "codex,100 --dangerously-bypass-approvals-and-sandbox\n  `-bash,200 -lc bun test",
    );
    expect(state.status).toBe("busy");
    expect(state.restartSafe).toBe(false);
  });

  test("marks persistent MCP child processes as unknown instead of idle", () => {
    const state = assessTurnState(
      "codex",
      "› ",
      "codex,100 --dangerously-bypass-approvals-and-sandbox\n  `-node,200 /usr/bin/npx @playwright/mcp@latest",
    );
    expect(state.status).toBe("unknown");
    expect(state.restartSafe).toBe(false);
  });
});
