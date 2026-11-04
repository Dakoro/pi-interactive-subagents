/** Run inside Herdr: PI_SUBAGENT_MUX=herdr npm run test:herdr. No model calls. */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  getMuxBackend, createSurface, createSurfaceSplit, sendLongCommand,
  readScreenAsync, closeSurface, pollForExit, shellEscape,
} from "../../pi-extension/subagents/mux.ts";

describe("live Herdr surface", { skip: getMuxBackend() !== "herdr", timeout: 20_000 }, () => {
  const panes: string[] = [];
  afterEach(() => {
    for (const pane of panes.splice(0).reverse()) {
      try { closeSurface(pane); } catch {}
    }
  });

  it("runs scripts in a child with its own Herdr identity and detects completion", async () => {
    const pane = createSurface("pi-herdr-smoke");
    panes.push(pane);
    // Allow the interactive shell to initialize before submitting its script.
    await new Promise(resolve => setTimeout(resolve, 1000));
    const marker = `HERDR_SMOKE_${Date.now()}`;
    sendLongCommand(pane, `printf '%s:%s\\n' ${shellEscape(marker)} "$HERDR_PANE_ID"; echo '__SUBAGENT_DONE_0__'`);
    const signal = AbortSignal.timeout(10_000);
    assert.deepEqual(await pollForExit(pane, signal, { interval: 100 }), { reason: "sentinel", exitCode: 0 });
    const text = await readScreenAsync(pane, 30);
    assert.ok(text.includes(`${marker}:${pane.slice("herdr:".length)}`));
    assert.notEqual(pane, `herdr:${process.env.HERDR_PANE_ID}`);
  });

  it("supports an explicitly targeted nested split", () => {
    const parent = createSurface("pi-herdr-parent");
    panes.push(parent);
    const child = createSurfaceSplit("pi-herdr-child", "down", parent);
    panes.push(child);
    assert.notEqual(child, parent);
    assert.ok(child.startsWith("herdr:"));
  });
});
