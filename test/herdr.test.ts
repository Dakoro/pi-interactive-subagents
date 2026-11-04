import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSurface, createSurfaceSplit, sendCommand, sendLongCommand,
  readScreen, readScreenAsync, closeSurface, getMuxBackend, isMuxAvailable, pollForExit,
} from "../pi-extension/subagents/mux.ts";
import { createHerdrStateReporter } from "../pi-extension/subagents/herdr-state.ts";

describe("Herdr CLI contract", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-herdr-test-"));
  const log = join(dir, "calls.jsonl");
  const binary = join(dir, "herdr binary");
  const keys = ["PATH", "HERDR_ENV", "HERDR_PANE_ID", "HERDR_SOCKET_PATH", "HERDR_BIN_PATH", "PI_SUBAGENT_MUX", "TMUX", "HERDR_TEST_LOG", "HERDR_TEST_SPLIT", "HERDR_TEST_READ", "HERDR_TEST_FAIL", "PI_SUBAGENT_SURFACE"];
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  const calls = () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(s => JSON.parse(s));

  before(() => {
    writeFileSync(binary, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.HERDR_TEST_LOG, JSON.stringify(args) + '\\n');
if (process.env.HERDR_TEST_FAIL && process.env.HERDR_TEST_FAIL === args[1]) process.exit(1);
if (args[0] === '--version') console.log('herdr 0.9.5');
else if (args[1] === 'split') console.log(process.env.HERDR_TEST_SPLIT || JSON.stringify({result:{pane:{pane_id:'w1:p2'}}}));
else if (args[1] === 'read') console.log(process.env.HERDR_TEST_READ || 'ready');
else console.log('{}');
`, { mode: 0o755 });
    writeFileSync(join(dir, "tmux"), "#!/bin/sh\necho '%99'\n", { mode: 0o755 });
  });

  beforeEach(() => {
    Object.assign(process.env, {
      HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: join(dir, "socket"),
      HERDR_BIN_PATH: binary, PI_SUBAGENT_MUX: "auto", TMUX: "outer-tmux",
      PI_SUBAGENT_SURFACE: "herdr:w1:p1", HERDR_TEST_LOG: log, PATH: `${dir}:${saved.PATH}`,
    });
    delete process.env.HERDR_TEST_SPLIT;
    delete process.env.HERDR_TEST_READ;
    delete process.env.HERDR_TEST_FAIL;
    writeFileSync(log, "");
  });

  after(() => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("prefers Herdr over an outer tmux and never falls back if Herdr is unavailable", () => {
    assert.equal(getMuxBackend(), "herdr");
    process.env.HERDR_BIN_PATH = join(dir, "missing");
    assert.equal(isMuxAvailable(), false);
    assert.throws(() => createSurface("worker"), /No supported multiplexer/);
    process.env.PI_SUBAGENT_MUX = "tmux";
    assert.equal(getMuxBackend(), "tmux");
    assert.equal(createSurface("worker"), "%99");
    process.env.PI_SUBAGENT_MUX = "typo";
    assert.equal(isMuxAvailable(), false);
  });

  it("requires the caller pane and socket and never controls focused panes implicitly", () => {
    delete process.env.HERDR_PANE_ID;
    assert.equal(isMuxAvailable(), false);
    process.env.HERDR_PANE_ID = "w1:p1";
    delete process.env.HERDR_SOCKET_PATH;
    assert.equal(isMuxAvailable(), false);
  });

  it("splits off the caller without changing focus and labels the new pane", () => {
    const surface = createSurface("worker 'quoted'");
    assert.equal(surface, "herdr:w1:p2");
    assert.ok(calls().some(c => JSON.stringify(c) === JSON.stringify(["pane", "split", "w1:p1", "--direction", "right", "--no-focus"])));
    assert.deepEqual(calls().at(-1), ["pane", "rename", "w1:p2", "worker 'quoted'"]);
    createSurfaceSplit("child", "down", surface);
    assert.ok(calls().some(c => c[1] === "split" && c[2] === "w1:p2" && c[4] === "down"));
    assert.throws(() => createSurfaceSplit("child", "up", surface), /right\/down/);
  });

  it("rejects malformed split responses and keeps a pane when cosmetic renaming fails", () => {
    process.env.HERDR_TEST_SPLIT = "not-json";
    assert.throws(() => createSurface("worker"), /Invalid JSON/);
    process.env.HERDR_TEST_SPLIT = '{"error":{"message":"no pane"}}';
    assert.throws(() => createSurface("worker"), /Unexpected/);
    delete process.env.HERDR_TEST_SPLIT;
    process.env.HERDR_TEST_FAIL = "rename";
    assert.equal(createSurface("worker"), "herdr:w1:p2");
  });

  it("routes existing surfaces by handle and delivers arbitrary text as one CLI argument", async () => {
    process.env.PI_SUBAGENT_MUX = "tmux";
    const injectionMarker = join(dir, "must-not-exist");
    const text = `apostrophe ' ; $(touch ${injectionMarker})\nnext line`;
    sendCommand("herdr:w1:p2", text);
    assert.deepEqual(calls().at(-1), ["pane", "run", "w1:p2", text]);
    assert.equal(existsSync(injectionMarker), false);
    assert.equal(readScreen("herdr:w1:p2", 17), "ready\n");
    assert.equal(await readScreenAsync("herdr:w1:p2", 4), "ready\n");
    assert.deepEqual(calls().at(-1), ["pane", "read", "w1:p2", "--source", "recent-unwrapped", "--lines", "4"]);
    closeSurface("herdr:w1:p2");
    assert.deepEqual(calls().at(-1), ["pane", "close", "w1:p2"]);
  });

  it("uses a script for long launches and detects exit status from Herdr output", async () => {
    const command = "printf '%s' 'long launch'";
    const path = sendLongCommand("herdr:w1:p2", command, { scriptPath: join(dir, "launch script.sh") });
    assert.ok(readFileSync(path, "utf8").includes(command));
    assert.deepEqual(calls().at(-1), ["pane", "run", "w1:p2", `bash '${path}'`]);
    process.env.HERDR_TEST_READ = "__SUBAGENT_DONE_7__";
    assert.deepEqual(await pollForExit("herdr:w1:p2", new AbortController().signal, { interval: 10 }), { reason: "sentinel", exitCode: 7 });
  });

  it("reports lifecycle states in order and releases only its own source", async () => {
    const reporter = createHerdrStateReporter();
    await Promise.all([reporter.report("working"), reporter.report("blocked", "Question?"), reporter.report("idle"), reporter.release()]);
    const entries = calls();
    assert.deepEqual(entries.map(c => c[1]), ["report-agent", "report-agent", "report-agent", "release-agent"]);
    assert.deepEqual(entries.slice(0, 3).map(c => c[c.indexOf("--state") + 1]), ["working", "blocked", "idle"]);
    assert.ok(entries.every(c => c[2] === "w1:p1" && c[c.indexOf("--source") + 1] === "pi-interactive-subagents"));
    const seqs = entries.map(c => Number(c[c.indexOf("--seq") + 1]));
    assert.ok(seqs.every((s, i) => i === 0 || s > seqs[i - 1]));
  });

  it("does no state reporting outside Herdr and tolerates reporting failures", async () => {
    delete process.env.HERDR_ENV;
    await createHerdrStateReporter().report("working");
    assert.deepEqual(calls(), []);
    process.env.HERDR_ENV = "1";
    process.env.PI_SUBAGENT_SURFACE = "%99";
    await createHerdrStateReporter().report("working");
    assert.deepEqual(calls(), []);
    process.env.PI_SUBAGENT_SURFACE = "herdr:w1:p1";
    process.env.HERDR_TEST_FAIL = "report-agent";
    await createHerdrStateReporter().report("working");
  });
});
