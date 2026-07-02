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
  resumeCommand?: string;
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
  const processTree = safeRun("pstree", ["-ap", String(rootPid)]).replace(/\s+/g, " ").trim();

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
  inventory              Read-only inventory of tmux panes and live agent processes
  capture                Capture pane scrollback to files without sending keys
  help                   Show this help

OPTIONS:
  --session <name>       Limit to one tmux session
  --pane <target>        Limit to one pane label or pane id, e.g. cashfirst:1.4 or %15
  --output-dir <dir>     Output directory for captures (default: .safe-agent-restart)
  --scrollback <lines>   Lines of pane history to capture (default: 5000)
  --json                 Emit JSON (default)
  --text                 Emit concise text

SAFETY:
  This tool does not quit, interrupt, respawn, or restart agents. It only reads tmux state
  and captures scrollback.`);
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

  console.log(String(value));
}

function main(): void {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.command === "help") {
      showHelp();
    } else if (options.command === "inventory") {
      printResult(inventory(options), options.json);
    } else if (options.command === "capture") {
      printResult(capture(options), options.json);
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
