import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runSession, resetCapRetryBudgetForTests } from "../src/session.js";

vi.mock("@actions/core");

// Runs the real Jules SDK against a fetch that only answers 429. The SDK
// retries every 429 itself; the action bounds that so its own create retries
// (5, 5, 5 and 15 minutes) stay the real schedule (#16).
const runOptions = {
  apiKey: "api-key",
  prompt: "prompt",
  source: { github: "owner/repo", baseBranch: "main" },
  title: "Code Review",
  timeoutMinutes: 1,
};

describe("Jules SDK retries", () => {
  beforeEach(() => {
    resetCapRetryBudgetForTests();
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("gives up on a create that only gets 429 in about 35 minutes, not 55", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("{}", { status: 429, statusText: "Too Many Requests" })
      )
    );
    const start = Date.now();
    let elapsedMinutes = Infinity;
    const settled = runSession(runOptions).finally(() => {
      elapsedMinutes = (Date.now() - start) / 60_000;
    });

    await vi.advanceTimersByTimeAsync(90 * 60_000);
    const outcome = await settled;

    expect(outcome.kind).toBe("creation_failed");
    expect(String(outcome.kind === "creation_failed" && outcome.error)).toMatch(
      /429/
    );
    // 30 minutes of the action's waits, plus about 1 minute of SDK retries
    // on each of the 5 attempts. The SDK default (5 minutes) gives about 55.
    expect(elapsedMinutes).toBeGreaterThan(30);
    expect(elapsedMinutes).toBeLessThan(40);
  });
});
