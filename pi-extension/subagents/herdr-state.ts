/** Lifecycle reporting for restricted children (global extensions are disabled). */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(execFile);
const SOURCE = "pi-interactive-subagents";

export function createHerdrStateReporter() {
  const pane = process.env.HERDR_PANE_ID;
  const enabled = process.env.HERDR_ENV === "1" && !!pane && !!process.env.HERDR_SOCKET_PATH
    && process.env.PI_SUBAGENT_SURFACE === `herdr:${pane}`;
  let seq = Date.now() * 1000;
  let pending = Promise.resolve();

  function enqueue(args: string[]): Promise<void> {
    if (!enabled) return Promise.resolve();
    pending = pending.then(async () => {
      try {
        await execAsync(process.env.HERDR_BIN_PATH || "herdr", args, { timeout: 1500 });
      } catch {
        // The terminal and parent result delivery work even if reporting fails.
      }
    });
    return pending;
  }

  return {
    report(state: "working" | "idle" | "blocked", message?: string) {
      return enqueue([
        "pane", "report-agent", pane ?? "", "--source", SOURCE, "--agent", "pi",
        "--state", state, "--seq", String(++seq),
        ...(message ? ["--message", message.slice(0, 80)] : []),
      ]);
    },
    release() {
      return enqueue(["pane", "release-agent", pane ?? "", "--source", SOURCE, "--agent", "pi", "--seq", String(++seq)]);
    },
  };
}
