import { describe, expect, test } from "bun:test";
import { Settings, type CreateAgentSessionOptions } from "@oh-my-pi/pi-coding-agent";
import type { SettingsOptions } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createOmpSessionOptions } from "./omp-session.ts";
import type { SessionRunInput } from "./types.ts";

function sessionInput(): SessionRunInput {
  return {
    composition: {
      prompt: "bounded prompt",
      evidence: [],
    } as unknown as SessionRunInput["composition"],
    config: {
      models: {
        coordinator: "pi/smol",
        siteAgent: "pi/smol",
        repairAgent: "pi/slow",
        verifier: "pi/task",
      },
      caps: {
        maxConcurrency: 3,
        maxDepth: 2,
        maxRuntimeMs: 60_000,
        maxLlmRequests: 16,
        maxCostUsd: 0.5,
        maxInputTokens: 200_000,
        maxOutputTokens: 40_000,
      },
    },
    signal: new AbortController().signal,
  };
}

describe("OMP session wiring", () => {
  test("inherits standard OMP auth/model discovery while keeping only session history in memory", async () => {
    const inheritedSettings = Settings.isolated();
    let loadedSettings: SettingsOptions | undefined;
    const options: CreateAgentSessionOptions = await createOmpSessionOptions(
      "/workspace/scrap-many",
      sessionInput(),
      {},
      async settingsOptions => {
        loadedSettings = settingsOptions;
        return inheritedSettings;
      },
    );

    expect(loadedSettings?.cwd).toBe("/workspace/scrap-many");
    expect(loadedSettings?.overrides).toMatchObject({
      "task.maxConcurrency": 3,
      "task.maxRecursionDepth": 2,
      "task.maxRuntimeMs": 60_000,
    });
    expect(options.settings).toBe(inheritedSettings);
    expect(Object.hasOwn(options, "authStorage")).toBe(false);
    expect(Object.hasOwn(options, "modelRegistry")).toBe(false);
    expect(Object.hasOwn(options, "agentDir")).toBe(false);
    expect(options.sessionManager?.getSessionFile()).toBeUndefined();
  });
});
