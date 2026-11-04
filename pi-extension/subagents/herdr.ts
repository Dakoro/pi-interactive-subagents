/** Herdr 0.9.5 CLI adapter. Only explicit pane targets are used. */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(execFile);
const PREFIX = "herdr:";
const CLI_OPTIONS = { encoding: "utf8" as const, timeout: 5000, maxBuffer: 4 * 1024 * 1024 };

function binary(): string {
  return process.env.HERDR_BIN_PATH || "herdr";
}

export function isHerdrAvailable(): boolean {
  if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_PANE_ID || !process.env.HERDR_SOCKET_PATH) return false;
  try {
    execFileSync(binary(), ["--version"], { ...CLI_OPTIONS, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function isHerdrSurface(surface: string): boolean {
  return surface.startsWith(PREFIX);
}

function paneId(surface: string): string {
  if (!isHerdrSurface(surface) || !surface.slice(PREFIX.length).trim()) {
    throw new Error(`Invalid Herdr surface: ${surface}`);
  }
  return surface.slice(PREFIX.length);
}

function run(args: string[]): string {
  return execFileSync(binary(), args, CLI_OPTIONS);
}

export function createHerdrSurface(
  name: string,
  direction: "left" | "right" | "up" | "down" = "right",
  fromSurface?: string,
): string {
  if (!isHerdrAvailable()) throw new Error("Start pi inside a Herdr pane with the herdr CLI available.");
  if (direction !== "right" && direction !== "down") {
    throw new Error(`Herdr supports right/down splits, not ${direction}.`);
  }
  const parent = fromSurface ? paneId(fromSurface) : process.env.HERDR_PANE_ID!;
  const output = run(["pane", "split", parent, "--direction", direction, "--no-focus"]);
  let response: any;
  try { response = JSON.parse(output); } catch {
    throw new Error(`Invalid JSON from herdr pane split: ${output}`);
  }
  const id = response?.result?.pane?.pane_id;
  if (response?.error || typeof id !== "string" || !id.trim()) {
    throw new Error(`Unexpected herdr pane split response: ${output}`);
  }
  const surface = PREFIX + id;
  try {
    run(["pane", "rename", id, name]);
  } catch {
    // A cosmetic label must not strand a successfully created pane.
  }
  return surface;
}

export function sendHerdrCommand(surface: string, command: string): void {
  // One ordered paste + Enter; no interpolation into a local shell.
  run(["pane", "run", paneId(surface), command]);
}

export function readHerdrScreen(surface: string, lines: number): string {
  return run(["pane", "read", paneId(surface), "--source", "recent-unwrapped", "--lines", String(Math.max(1, lines))]);
}

export async function readHerdrScreenAsync(surface: string, lines: number): Promise<string> {
  const { stdout } = await execAsync(binary(), ["pane", "read", paneId(surface), "--source", "recent-unwrapped", "--lines", String(Math.max(1, lines))], CLI_OPTIONS);
  return stdout;
}

export function closeHerdrSurface(surface: string): void {
  run(["pane", "close", paneId(surface)]);
}
