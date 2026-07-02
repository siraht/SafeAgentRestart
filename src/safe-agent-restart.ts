#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type AgentKind = "codex" | "claude" | "opencode" | "unknown";

interface Pane {
  paneId: string;
  label: string;
  rootPid: number;
  tty: string;
  title: string;
  cwd: string;
  currentCommand: string;
  processTree: string;
  agent: AgentDetection;
}

interface AgentDetection {
  kind: AgentKind;
  rootPid?: number;
  invocation?: string;
  bypassMode: boolean;
}

interface RestartPlan {
  generatedAt: string;
  scrollbackLines: number;
  updatePlan: UpdatePlan;
  panes: RestartPlanItem[];
}

interface RestartPlanItem {
  pane: string;
  paneId: string;
  cwd: string;
  kind: AgentKind;
  currentBypassMode: boolean;
  turnState: TurnState;
  sessionIds: string[];
  recommendedResumeCommand?: string;
  gracefulQuitKeys: string[];
  notes: string[];
}

type ManagedTool = "codex" | "claude" | "opencode";

interface UpdatePlan {
  generatedAt: string;
  tools: ToolUpdate[];
  commands: string[];
  notes: string[];
}

interface ToolUpdate {
  tool: ManagedTool;
  available: boolean;
  command?: string;
  path?: string;
  resolvedPath?: string;
  version?: string;
  installMethod?: string;
  reinstallCommand?: string;
  notes: string[];
}

type TurnStatus = "idle" | "busy" | "unknown";

interface TurnState {
  status: TurnStatus;
  restartSafe: boolean;
  evidence: string[];
  notes: string[];
}

interface ReadinessReport {
  generatedAt: string;
  panes: ReadinessItem[];
}

interface ReadinessItem {
  pane: string;
  paneId: string;
  cwd: string;
  kind: AgentKind;
  turnState: TurnState;
}

interface ActiveChildCommand {
  line: string;
  likelyPersistentService: boolean;
}

interface CliOptions {
  command: string;
  session?: string;
  pane?: string;
  json: boolean;
  outputDir: string;
  scrollback: number;
}

const DEFAULT_OUTPUT_DIR = ".safe-agent-restart";
const DEFAULT_SCROLLBACK = 5000;

function run(command: string, args: string[]): string {
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const err = error as { status?: number; stderr?: Buffer | string; message?: string };
    const detail = typeof err.stderr === "string" ? err.stderr : err.stderr?.toString();
    throw new Error(`${command} ${args.join(" ")} failed${err.status ? ` with exit ${err.status}` : ""}${detail ? `: ${detail.trim()}` : err.message ? `: ${err.message}` : ""}`);
  }
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    command: "help",
    json: true,
    outputDir: DEFAULT_OUTPUT_DIR,
    scrollback: DEFAULT_SCROLLBACK,
  };

  const args = [...argv];
  if (args.length > 0 && !args[0]!.startsWith("-")) {
    options.command = args.shift()!;
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const next = args[i + 1];
    if (arg === "--session") {
      options.session = requireValue(arg, next);
      i++;
    } else if (arg === "--pane") {
      options.pane = requireValue(arg, next);
      i++;
    } else if (arg === "--output-dir") {
      options.outputDir = requireValue(arg, next);
      i++;
    } else if (arg === "--scrollback") {
      options.scrollback = parsePositiveInt(requireValue(arg, next), arg);
      i++;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--text") {
      options.json = false;
    } else if (arg === "--help" || arg === "-h") {
      options.command = "help";
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function requireValue(flag: string, value: string | undefined): string {
  if (!value || value.startsWith("-")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parsePositiveInt(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function listPaneRows(session?: string): string[] {
  const format = "#{pane_id}\t#{session_name}:#{window_index}.#{pane_index}\t#{pane_pid}\t#{pane_tty}\t#{pane_title}\t#{pane_current_path}\t#{pane_current_command}";
  const args = session ? ["list-panes", "-t", session, "-F", format] : ["list-panes", "-a", "-F", format];
  const output = run("tmux", args);
  return output.split("\n").filter(Boolean);
}

function inspectPane(row: string): Pane {
  const [paneId, label, rootPidRaw, tty, title, cwd, currentCommand] = row.split("\t");
  if (!paneId || !label || !rootPidRaw || !tty || !title || !cwd || !currentCommand) {
    throw new Error(`Unexpected tmux pane row: ${row}`);
  }

  const rootPid = parsePositiveInt(rootPidRaw, "pane_pid");
  const processTree = safeRun("pstree", ["-ap", String(rootPid)]).trim();

  return {
    paneId,
    label,
    rootPid,
    tty,
    title,
    cwd,
    currentCommand,
    processTree,
    agent: detectAgent(processTree, currentCommand),
  };
}

function safeRun(command: string, args: string[]): string {
  try {
    return run(command, args);
  } catch {
    return "";
  }
}

export function detectAgent(processTree: string, currentCommand = ""): AgentDetection {
  const haystack = `${currentCommand} ${processTree}`;
  if (/\bclaude\b/i.test(haystack)) {
    const invocation = extractInvocation(processTree, "claude");
    return withOptionalProcess({
      kind: "claude",
      bypassMode: /--dangerously-skip-permissions|--permission-mode[ =]bypassPermissions/i.test(haystack),
    }, invocation);
  }

  if (/\bcodex\b/i.test(haystack)) {
    const invocation = extractInvocation(processTree, "codex");
    return withOptionalProcess({
      kind: "codex",
      bypassMode: /--dangerously-bypass-approvals-and-sandbox/i.test(haystack),
    }, invocation);
  }

  if (/\bopencode\b/i.test(haystack)) {
    const invocation = extractInvocation(processTree, "opencode");
    return withOptionalProcess({
      kind: "opencode",
      bypassMode: false,
    }, invocation);
  }

  return { kind: "unknown", bypassMode: false };
}

function withOptionalProcess(base: AgentDetection, invocation: string | undefined): AgentDetection {
  const rootPid = extractPid(invocation);
  return {
    ...base,
    ...(invocation ? { invocation } : {}),
    ...(rootPid ? { rootPid } : {}),
  };
}

function extractInvocation(processTree: string, binary: string): string | undefined {
  const pattern = new RegExp(`(?:^|[\\s|\\-\\\\` + "`" + `])(${binary},\\d+[^|` + "`" + `]*)`, "i");
  return processTree.match(pattern)?.[1]?.trim();
}

function extractPid(invocation: string | undefined): number | undefined {
  const value = invocation?.match(/^[^,]+,(\d+)/)?.[1];
  return value ? Number.parseInt(value, 10) : undefined;
}

function inventory(options: CliOptions): Pane[] {
  const panes = listPaneRows(options.session).map(inspectPane);
  return options.pane ? panes.filter((pane) => pane.label === options.pane || pane.paneId === options.pane) : panes;
}

function showHelp(): void {
  console.log(`SafeAgentRestart

USAGE:
  safe-agent-restart <command> [options]

COMMANDS:
  update-plan            Detect installed agent CLIs and print update/reinstall commands
  inventory              Read-only inventory of tmux panes and live agent processes
  readiness              Check whether detected panes look between turns
  capture                Capture pane scrollback to files without sending keys
  plan                   Build read-only restart/resume plan from pane scrollback
  sequence               Print the manual restart sequence for Codex, Claude, and OpenCode
  help                   Show this help

OPTIONS:
  --session <name>       Limit to one tmux session
  --pane <target>        Limit to one pane label or pane id, e.g. cashfirst:1.4 or %15
  --output-dir <dir>     Output directory for captures (default: .safe-agent-restart)
  --scrollback <lines>   Lines of pane history to capture (default: 5000)
  --json                 Emit JSON (default)
  --text                 Emit concise text

SAFETY:
  This tool does not quit, interrupt, respawn, restart agents, or run update commands.
  It only reads tmux/process state and captures scrollback.`);
}

function capture(options: CliOptions): { outputDir: string; captures: Array<{ pane: string; path: string }> } {
  const panes = inventory(options).filter((pane) => pane.agent.kind !== "unknown");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputDir = join(options.outputDir, "captures", stamp);
  mkdirSync(outputDir, { recursive: true });

  const captures = panes.map((pane) => {
    const safeLabel = pane.label.replace(/[^A-Za-z0-9_.-]+/g, "_");
    const path = join(outputDir, `${safeLabel}.txt`);
    const text = run("tmux", ["capture-pane", "-p", "-t", pane.paneId, "-S", `-${options.scrollback}`]);
    writeFileSync(path, text);
    return { pane: pane.label, path };
  });

  return { outputDir, captures };
}

function readiness(options: CliOptions): ReadinessReport {
  const panes = inventory(options).filter((pane) => pane.agent.kind !== "unknown");
  return {
    generatedAt: new Date().toISOString(),
    panes: panes.map((pane) => ({
      pane: pane.label,
      paneId: pane.paneId,
      cwd: pane.cwd,
      kind: pane.agent.kind,
      turnState: assessTurnState(pane.agent.kind, captureVisiblePane(pane.paneId), pane.processTree),
    })),
  };
}

function buildPlan(options: CliOptions): RestartPlan {
  const panes = inventory(options).filter((pane) => pane.agent.kind !== "unknown");
  return {
    generatedAt: new Date().toISOString(),
    scrollbackLines: options.scrollback,
    updatePlan: buildUpdatePlan(),
    panes: panes.map((pane) => {
      const visibleText = captureVisiblePane(pane.paneId);
      const scrollback = safeRun("tmux", ["capture-pane", "-p", "-t", pane.paneId, "-S", `-${options.scrollback}`]);
      const sessionIds = extractSessionIds(scrollback);
      const latestSessionId = sessionIds.at(-1);
      const recommendedResumeCommand = buildResumeCommand(pane.agent.kind, latestSessionId);
      return {
        pane: pane.label,
        paneId: pane.paneId,
        cwd: pane.cwd,
        kind: pane.agent.kind,
        currentBypassMode: pane.agent.bypassMode,
        turnState: assessTurnState(pane.agent.kind, visibleText, pane.processTree),
        sessionIds,
        ...(recommendedResumeCommand ? { recommendedResumeCommand } : {}),
        gracefulQuitKeys: ["C-c"],
        notes: buildNotes(pane.agent.kind, latestSessionId),
      };
    }),
  };
}

function captureVisiblePane(paneId: string): string {
  return safeRun("tmux", ["capture-pane", "-p", "-t", paneId]);
}

export function extractSessionIds(text: string): string[] {
  const matches = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? [];
  return [...new Set(matches.map((match) => match.toLowerCase()))];
}

export function assessTurnState(kind: AgentKind, visibleText: string, processTree: string): TurnState {
  const evidence: string[] = [];
  const notes: string[] = [];
  const recentText = tailNonEmptyLines(visibleText, 80).join("\n");
  const activeChild = detectActiveChildCommand(kind, processTree);

  if (activeChild?.likelyPersistentService) {
    evidence.push(`persistent child process: ${activeChild.line}`);
    return {
      status: "unknown",
      restartSafe: false,
      evidence,
      notes: ["A persistent child service appears to be attached to the agent; skip automatic restart."],
    };
  }

  if (activeChild) {
    evidence.push(`active child process: ${activeChild.line}`);
    return {
      status: "busy",
      restartSafe: false,
      evidence,
      notes: ["A tool or shell process appears to be running under the agent."],
    };
  }

  const busyMarker = detectBusyMarker(kind, recentText);
  if (busyMarker) {
    evidence.push(`busy screen marker: ${busyMarker}`);
    return {
      status: "busy",
      restartSafe: false,
      evidence,
      notes: ["The visible TUI still looks mid-turn."],
    };
  }

  const draftPrompt = detectPromptDraft(kind, recentText);
  if (draftPrompt) {
    evidence.push(`prompt has draft text: ${draftPrompt}`);
    return {
      status: "unknown",
      restartSafe: false,
      evidence,
      notes: ["The pane may be waiting for input, but a visible draft could be lost."],
    };
  }

  const idlePrompt = detectIdlePrompt(kind, recentText);
  if (idlePrompt) {
    evidence.push(`idle prompt marker: ${idlePrompt}`);
    return {
      status: "idle",
      restartSafe: true,
      evidence,
      notes: ["Conservative screen check found an idle prompt and no active child command."],
    };
  }

  return {
    status: "unknown",
    restartSafe: false,
    evidence,
    notes: ["No reliable idle prompt was detected; skip automatic restart for this pane."],
  };
}

function tailNonEmptyLines(text: string, count: number): string[] {
  return text
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(-count);
}

function detectActiveChildCommand(kind: AgentKind, processTree: string): ActiveChildCommand | undefined {
  const processLines = processTree.split("\n").map((line) => line.trim()).filter(Boolean).slice(1);
  const activeCommand = /\b(?:bash|zsh|sh|fish|node|bun|npm|pnpm|yarn|python|python3|ruby|go|cargo|rustc|gcc|g\+\+|make|cmake|git|rg|grep|curl|wget|tsx|ts-node|deno|uv|pytest|playwright)\b/i;
  for (const line of processLines) {
    if (!activeCommand.test(line)) continue;
    if (isAgentWrapperLine(kind, line)) continue;
    if (/\{[^}]+\}/.test(line)) continue;
    const compactLine = line.replace(/\s+/g, " ");
    return {
      line: compactLine,
      likelyPersistentService: /\bmcp\b|@playwright\/mcp|n8n-mcp/i.test(compactLine),
    };
  }
  return undefined;
}

function isAgentWrapperLine(kind: AgentKind, line: string): boolean {
  const lower = line.toLowerCase();
  if (kind === "codex") {
    return lower.includes("/codex") || /\bcodex,\d+/.test(lower);
  }
  if (kind === "claude") {
    return lower.includes("/claude") || /\bclaude,\d+/.test(lower);
  }
  if (kind === "opencode") {
    return lower.includes("/opencode") || /\bopencode,\d+/.test(lower);
  }
  return false;
}

function detectBusyMarker(kind: AgentKind, text: string): string | undefined {
  const markers: Array<[RegExp, string]> = [
    [/\b(Pursuing goal|Running|Executing|Applying patch|Editing|Thinking|Working)\b/i, "active status text"],
    [/\b(ctrl\+c|esc|escape)\s+to\s+(interrupt|stop|cancel)\b/i, "interrupt hint"],
    [/\b(waiting for|running)\s+(tool|command|approval)\b/i, "tool status"],
  ];
  if (kind === "claude") {
    markers.push([/[✻✽]\s*(Working|Thinking|Running)/i, "Claude activity glyph"]);
  }
  if (kind === "opencode") {
    markers.push([/\b(Session|Assistant)\s+(running|thinking)\b/i, "OpenCode activity text"]);
  }

  for (const [pattern, label] of markers) {
    if (pattern.test(text)) return label;
  }
  return undefined;
}

function detectPromptDraft(kind: AgentKind, text: string): string | undefined {
  const promptPatterns = promptRegexes(kind);
  const lines = tailNonEmptyLines(text, 12);
  for (const line of lines) {
    for (const pattern of promptPatterns) {
      const match = line.match(pattern);
      if (match?.groups?.draft && match.groups.draft.trim().length > 0) {
        return truncateEvidence(line.trim());
      }
    }
  }
  return undefined;
}

function detectIdlePrompt(kind: AgentKind, text: string): string | undefined {
  const promptPatterns = promptRegexes(kind);
  const lines = tailNonEmptyLines(text, 12);
  for (const line of lines.reverse()) {
    for (const pattern of promptPatterns) {
      const match = line.match(pattern);
      if (match && (!match.groups?.draft || match.groups.draft.trim().length === 0)) {
        return truncateEvidence(line.trim());
      }
    }
  }
  return undefined;
}

function promptRegexes(kind: AgentKind): RegExp[] {
  const codexPrompt = /^\s*›\s*(?<draft>.*)$/;
  const claudePrompt = /^\s*❯\s*(?<draft>.*)$/;
  const asciiPrompt = /^\s*>\s*(?<draft>.*)$/;
  if (kind === "codex") return [codexPrompt];
  if (kind === "claude") return [claudePrompt];
  if (kind === "opencode") return [asciiPrompt, claudePrompt];
  return [codexPrompt, claudePrompt, asciiPrompt];
}

function truncateEvidence(value: string): string {
  return value.length > 100 ? `${value.slice(0, 97)}...` : value;
}

export function buildResumeCommand(kind: AgentKind, sessionId: string | undefined): string | undefined {
  if (kind === "codex") {
    return sessionId
      ? `codex --dangerously-bypass-approvals-and-sandbox resume ${sessionId}`
      : "codex --dangerously-bypass-approvals-and-sandbox resume --last";
  }

  if (kind === "claude") {
    return sessionId
      ? `claude --dangerously-skip-permissions --resume ${sessionId}`
      : "claude --dangerously-skip-permissions --continue";
  }

  if (kind === "opencode") {
    return sessionId ? `opencode --session ${sessionId}` : "opencode --continue";
  }

  return undefined;
}

function buildNotes(kind: AgentKind, sessionId: string | undefined): string[] {
  if (kind === "opencode") {
    return ["OpenCode does not expose a yolo/bypass flag in local help; resume command uses its session or continue option."];
  }
  if (!sessionId) {
    return ["No UUID-style session id was visible in captured scrollback; command uses latest-session fallback."];
  }
  return ["Review captured scrollback before quitting if the pane appears mid-task."];
}

export function detectToolUpdate(tool: ManagedTool): ToolUpdate {
  const path = which(tool);
  if (!path) {
    return {
      tool,
      available: false,
      notes: [`${tool} is not on PATH.`],
    };
  }

  const resolvedPath = safeRun("readlink", ["-f", path]).trim() || path;
  const version = safeRun(tool, ["--version"]).trim().split("\n")[0]?.trim();
  const detected = detectInstallMethod(tool, path, resolvedPath);
  return {
    tool,
    available: true,
    path,
    resolvedPath,
    ...(version ? { version } : {}),
    ...(detected.installMethod ? { installMethod: detected.installMethod } : {}),
    ...(detected.command ? { command: detected.command } : {}),
    ...(detected.reinstallCommand ? { reinstallCommand: detected.reinstallCommand } : {}),
    notes: detected.notes,
  };
}

function detectInstallMethod(
  tool: ManagedTool,
  path: string,
  resolvedPath: string,
): Pick<ToolUpdate, "installMethod" | "command" | "reinstallCommand" | "notes"> {
  if (tool === "codex") {
    if (resolvedPath.includes("/.codex/packages/standalone/") || path.includes("/.codex/packages/standalone/")) {
      return {
        installMethod: "codex standalone",
        command: "codex update",
        notes: ["Detected Codex standalone install; use its built-in updater before restarting panes."],
      };
    }
    return {
      installMethod: "unknown",
      command: "codex update",
      notes: ["Codex is available, but the install method is not recognized; built-in update is the safest generic command."],
    };
  }

  if (tool === "claude") {
    if (resolvedPath.includes("/.local/share/claude/versions/")) {
      return {
        installMethod: "claude native",
        command: "claude update",
        reinstallCommand: "claude install stable --force",
        notes: ["Detected Claude Code native install; update first, or force reinstall stable if update reports corruption."],
      };
    }
    return {
      installMethod: "unknown",
      command: "claude update",
      reinstallCommand: "claude install stable --force",
      notes: ["Claude Code is available, but the install method is not recognized; built-in update is the safest generic command."],
    };
  }

  if (path.includes("/.bun/bin/") || resolvedPath.includes("/.bun/lib/node_modules/opencode-ai/")) {
    return {
      installMethod: "bun global",
      command: "opencode upgrade --method bun",
      notes: ["Detected OpenCode Bun global install; pin the upgrade method so it uses the same package manager."],
    };
  }

  return {
    installMethod: "unknown",
    command: "opencode upgrade",
    notes: ["OpenCode is available, but the install method is not recognized; review opencode upgrade --help before running."],
  };
}

function which(command: string): string | undefined {
  return safeRun("bash", ["-lc", `command -v ${shellQuote(command)}`]).trim() || undefined;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function buildUpdatePlan(): UpdatePlan {
  const tools = (["codex", "claude", "opencode"] as const).map(detectToolUpdate);
  return {
    generatedAt: new Date().toISOString(),
    tools,
    commands: tools.flatMap((tool) => (tool.command ? [tool.command] : [])),
    notes: [
      "Run update commands before quitting any live agent pane.",
      "Review reinstallCommand values only if the normal updater fails or reports an unhealthy install.",
    ],
  };
}

function showSequence(): void {
  console.log(`Safe manual restart sequence

0. Update agent CLIs before touching live panes:
   safe-agent-restart update-plan --text

   Run the printed update commands. On this machine that normally means:
   Codex:   codex update
   Claude:  claude update
   OpenCode: opencode upgrade --method bun

1. Capture scrollback:
   safe-agent-restart capture --pane '<session:window.pane>'

2. Confirm the pane looks between turns:
   safe-agent-restart readiness --pane '<session:window.pane>' --text

3. Build the read-only plan:
   safe-agent-restart plan --pane '<session:window.pane>' --text

4. Gracefully quit only that pane's agent if readiness says restartSafe=true:
   tmux send-keys -t '<session:window.pane>' C-c

5. Capture the post-quit output:
   tmux capture-pane -p -t '<session:window.pane>' -S -5000

6. Resume with the planned command, or replace the session id with the post-quit id:
   Codex:    codex --dangerously-bypass-approvals-and-sandbox resume <session-id>
   Claude:   claude --dangerously-skip-permissions --resume <session-id>
   OpenCode: opencode --session <session-id>

Fallbacks when no session id is visible:
   Codex:    codex --dangerously-bypass-approvals-and-sandbox resume --last
   Claude:   claude --dangerously-skip-permissions --continue
   OpenCode: opencode --continue

This project intentionally does not automate quit/resume steps yet.`);
}

function printResult(value: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }

  if (Array.isArray(value)) {
    for (const pane of value as Pane[]) {
      if (pane.agent.kind === "unknown") continue;
      console.log(`${pane.label}\t${pane.agent.kind}\tpid=${pane.agent.rootPid ?? "unknown"}\tbypass=${pane.agent.bypassMode}\tcwd=${pane.cwd}`);
    }
    return;
  }

  if (isRestartPlan(value)) {
    console.log("preflight updates:");
    for (const command of value.updatePlan.commands) {
      console.log(`  ${command}`);
    }
    for (const pane of value.panes) {
      console.log(`${pane.pane}\t${pane.kind}\tturn=${pane.turnState.status}\trestartSafe=${pane.turnState.restartSafe}\t${pane.recommendedResumeCommand ?? "no-resume-command"}\tcwd=${pane.cwd}`);
      for (const item of pane.turnState.evidence) {
        console.log(`  evidence: ${item}`);
      }
      for (const note of pane.notes) {
        console.log(`  note: ${note}`);
      }
    }
    return;
  }

  if (isReadinessReport(value)) {
    for (const pane of value.panes) {
      console.log(`${pane.pane}\t${pane.kind}\tturn=${pane.turnState.status}\trestartSafe=${pane.turnState.restartSafe}\tcwd=${pane.cwd}`);
      for (const item of pane.turnState.evidence) {
        console.log(`  evidence: ${item}`);
      }
      for (const note of pane.turnState.notes) {
        console.log(`  note: ${note}`);
      }
    }
    return;
  }

  if (isUpdatePlan(value)) {
    for (const tool of value.tools) {
      if (!tool.available) {
        console.log(`${tool.tool}\tunavailable`);
        continue;
      }
      console.log(`${tool.tool}\t${tool.installMethod ?? "unknown"}\t${tool.command ?? "no-update-command"}\tversion=${tool.version ?? "unknown"}`);
      if (tool.reinstallCommand) {
        console.log(`  reinstall-if-needed: ${tool.reinstallCommand}`);
      }
      for (const note of tool.notes) {
        console.log(`  note: ${note}`);
      }
    }
    return;
  }

  console.log(String(value));
}

function isRestartPlan(value: unknown): value is RestartPlan {
  return Boolean(value && typeof value === "object" && "panes" in value && "updatePlan" in value && "scrollbackLines" in value);
}

function isUpdatePlan(value: unknown): value is UpdatePlan {
  return Boolean(value && typeof value === "object" && "tools" in value && "commands" in value);
}

function isReadinessReport(value: unknown): value is ReadinessReport {
  return Boolean(value && typeof value === "object" && "panes" in value && "generatedAt" in value);
}

function main(): void {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.command === "help") {
      showHelp();
    } else if (options.command === "update-plan") {
      printResult(buildUpdatePlan(), options.json);
    } else if (options.command === "inventory") {
      printResult(inventory(options), options.json);
    } else if (options.command === "readiness") {
      printResult(readiness(options), options.json);
    } else if (options.command === "capture") {
      printResult(capture(options), options.json);
    } else if (options.command === "plan") {
      printResult(buildPlan(options), options.json);
    } else if (options.command === "sequence") {
      showSequence();
    } else {
      throw new Error(`Unknown command: ${options.command}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`safe-agent-restart: ${message}`);
    process.exit(1);
  }
}

if (import.meta.main) {
  main();
}
