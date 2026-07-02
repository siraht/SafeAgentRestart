import { describe, expect, test } from "bun:test";
import { buildResumeCommand, detectAgent, extractSessionIds } from "../src/safe-agent-restart";

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
});
