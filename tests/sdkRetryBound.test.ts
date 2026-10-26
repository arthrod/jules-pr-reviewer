import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runSession, resetCapRetryBudgetForTests } from "../src/session.js";

vi.mock("@actions/core");

// Runs the real Jules SDK against a stubbed fetch. The SDK retries every 429
// itself; the action limits that to about a minute per request, so its own
// create retries (5, 5, 5 and 15 minutes) stay the real schedule (#16).
const runOptions = {
  apiKey: "api-key",
  prompt: "prompt",
  source: { github: "owner/repo", baseBranch: "main" },
  title: "Code Review",
  timeoutMinutes: 1,
};

const tooManyRequests = () =>
  new Response("{}", { status: 429, statusText: "Too Many Requests" });

/** Minutes of fake time until runSession gives up creating the session. */
async function minutesUntilCreationFails(
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>
): Promise<number> {
  vi.stubGlobal("fetch", vi.fn(fetchImpl));
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
  return elapsedMinutes;
}

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

  // 30 minutes of the action's waits, plus about 1 minute of SDK retries on
  // each of the 5 attempts: about 35. The SDK default (5 minutes) gives about
  // 55, and no SDK retries at all give 30.
  it("gives up on a create when every request gets 429 in about 35 minutes", async () => {
    const minutes = await minutesUntilCreationFails(async () =>
      tooManyRequests()
    );

    expect(minutes).toBeGreaterThan(34);
    expect(minutes).toBeLessThan(40);
  });

  it("bounds the create request too when the source lookup succeeds", async () => {
    let creates = 0;
    const minutes = await minutesUntilCreationFails(async (_url, init) => {
      if (init?.method !== "POST") {
        return Response.json({
          name: "sources/github/owner/repo",
          id: "github/owner/repo",
          githubRepo: { owner: "owner", repo: "repo" },
        });
      }
      creates++;
      return tooManyRequests();
    });

    // Each of the 5 attempts reaches the create and retries it.
    expect(creates).toBeGreaterThan(5);
    expect(minutes).toBeGreaterThan(34);
    expect(minutes).toBeLessThan(40);
  });
});
