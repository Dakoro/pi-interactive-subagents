import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

describe("Pi 1.5 SDK extension loading", () => {
  it("loads parent, child and restricted bash through the official loader", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sdk-test-"));
    const project = join(root, "project");
    const agentDir = join(root, "agent");
    mkdirSync(project);
    mkdirSync(agentDir);
    try {
      const expected = [
        ["pi-extension/subagents/index.ts", ["subagent", "subagent_message", "subagents_list"]],
        ["pi-extension/subagents/subagent-done.ts", ["ask_question"]],
        ["pi-extension/subagents/tools/safe-bash.ts", ["safe_bash"]],
      ] as const;
      for (const [path, tools] of expected) {
        const result = await discoverAndLoadExtensions([resolve(path)], project, agentDir);
        assert.deepEqual(result.errors, [], path);
        assert.deepEqual(result.warnings ?? [], [], path);
        const extension = result.extensions.find(e => e.resolvedPath === resolve(path));
        assert.ok(extension, path);
        assert.deepEqual([...extension.tools.keys()].sort(), [...tools].sort(), path);
        for (const { definition } of extension.tools.values()) {
          assert.equal(definition.parameters.type, "object");
          assert.equal(typeof definition.execute, "function");
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
