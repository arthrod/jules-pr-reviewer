/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runSession, resetCapRetryBudgetForTests } from "../src/session.js";
import { runJulesReview, runAgenticReview } from "../src/jules.js";
import { classifyFailure } from "../src/errors.js";
import { isAuthError, QuotaExceededError, AuthError } from "../src/errors.js";
import { jules } from "@google/jules-sdk";
import * as core from "@actions/core";

vi.mock("@actions/core");

const mockSession = (historyEvents: any[]) => {
  return {
    id: "test-session-id",
    info: vi.fn().mockResolvedValue({ state: "inProgress" }),
    hydrate: vi.fn().mockResolvedValue(1),
    archive: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(undefined),
    history: async function* () {
      for (const event of historyEvents) {
        yield event;
      }
    },
  };
};

const concurrencyCapMessage = `[400 Bad Request] POST https://jules.googleapis.com/v1alpha/sessions - {
  "error": {
    "code": 400,
    "message": "Precondition check failed.",
    "status": "FAILED_PRECONDITION"
  }
}`;

const creationRefusals = [
  {
    message: concurrencyCapMessage,
    description:
      "HTTP 400 FAILED_PRECONDITION (the account may be at its daily task limit or its concurrency cap)",
  },
  {
    message:
      "[429 Too Many Requests] POST https://jules.googleapis.com/v1alpha/sessions",
    description: "HTTP 429 (quota or rate limit exceeded)",
  },
];

const runOptions = {
  apiKey: "api-key",
  prompt: "prompt",
  source: { github: "owner/repo", baseBranch: "main" },
  title: "Code Review",
  timeoutMinutes: 1,
};

describe("session.ts", () => {
  beforeEach(() => {
    resetCapRetryBudgetForTests();
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("runSession", () => {
    describe("SDK cache location", () => {
      const saved = {
        JULES_HOME: process.env.JULES_HOME,
        RUNNER_TEMP: process.env.RUNNER_TEMP,
      };
      const restore = (key: "JULES_HOME" | "RUNNER_TEMP") => {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      };
      /** JULES_HOME as seen when the SDK client is created; the run stops there. */
      const julesHomeAtClientCreation = async (): Promise<
        string | undefined
      > => {
        let seen: string | undefined;
        const spy = vi.spyOn(jules, "with").mockImplementation(() => {
          seen = process.env.JULES_HOME;
          throw new Error("stop after client creation");
        });
        try {
          await expect(runSession(runOptions)).rejects.toThrow(
            "stop after client creation"
          );
        } finally {
          spy.mockRestore();
        }
        return seen;
      };

      afterEach(() => {
        restore("JULES_HOME");
        restore("RUNNER_TEMP");
      });

      it("points JULES_HOME at RUNNER_TEMP before the SDK client exists", async () => {
        delete process.env.JULES_HOME;
        process.env.RUNNER_TEMP = "/runner/_temp";

        expect(await julesHomeAtClientCreation()).toBe("/runner/_temp");
      });

      it("keeps an explicitly configured JULES_HOME", async () => {
        process.env.JULES_HOME = "/custom/jules";
        process.env.RUNNER_TEMP = "/runner/_temp";

        expect(await julesHomeAtClientCreation()).toBe("/custom/jules");
      });

      it("leaves JULES_HOME unset outside a runner", async () => {
        delete process.env.JULES_HOME;
        delete process.env.RUNNER_TEMP;

        expect(await julesHomeAtClientCreation()).toBeUndefined();
      });
    });

    it("returns a review outcome when the session produces a parseable message", async () => {
      const session = mockSession([
        {
          type: "agentMessaged",
          message: '{"summary":"ok","verdict":"approve"}',
        },
      ]);
      (jules as any).with = vi.fn().mockReturnValue({
        session: vi.fn().mockResolvedValue(session),
      });

      const result = await runSession(runOptions);

      expect(result.kind).toBe("review");
      if (result.kind === "review") {
        expect(result.sessionId).toBe("test-session-id");
        expect(result.reviewResult.verdict).toBe("approve");
      }
      expect(session.archive).toHaveBeenCalled();
    });

    it("returns a block-verdict fallback review when the message cannot be parsed", async () => {
      const session = mockSession([
        { type: "agentMessaged", message: "this is not json" },
      ]);
      (jules as any).with = vi.fn().mockReturnValue({
        session: vi.fn().mockResolvedValue(session),
      });

      session.info.mockResolvedValue({ state: "completed" });
      const promise = runSession(runOptions);
      await vi.advanceTimersByTimeAsync(60_000);
      const result = await promise;

      expect(result).toEqual({
        kind: "review",
        reviewResult: {
          summary: expect.stringContaining("could not be parsed"),
          verdict: "block",
          resolvedCommentIds: [],
          newComments: [],
          unparseable: true,
        },
        sessionId: "test-session-id",
      });
      expect(core.error).toHaveBeenCalled();
      expect(session.archive).toHaveBeenCalled();
    });

    it("logs a review_failed structured event with stage parse on parse failure", async () => {
      const session = mockSession([
        { type: "agentMessaged", message: "not valid json at all" },
      ]);
      (jules as any).with = vi.fn().mockReturnValue({
        session: vi.fn().mockResolvedValue(session),
      });

      session.info.mockResolvedValue({ state: "completed" });
      const promise = runSession(runOptions);
      await vi.advanceTimersByTimeAsync(60_000);
      await promise;

      expect(core.info).toHaveBeenCalledWith(
        expect.stringContaining('"event":"review_failed"')
      );
      expect(core.info).toHaveBeenCalledWith(
        expect.stringContaining('"stage":"parse"')
      );
      expect(core.info).toHaveBeenCalledWith(
        expect.stringContaining('"kind":"parse"')
      );
    });

    it.each([
      "I'll start by reading the diff…",
      '{"summary":"Still reviewing","verdict":"pending"}',
    ])("keeps polling past an invalid review: %s", async (message) => {
      const events = [{ type: "agentMessaged", message }];
      const session = mockSession(events);
      session.info.mockResolvedValue({ state: "completed" });
      vi.spyOn(jules, "with").mockReturnValue({
        ...jules,
        session: vi.fn().mockResolvedValue(session),
      });
      const promise = runSession(runOptions);
      await vi.advanceTimersByTimeAsync(19_999);
      expect(session.archive).not.toHaveBeenCalled();
      expect(core.error).not.toHaveBeenCalled();

      events.push({
        type: "agentMessaged",
        message: '{"summary":"Reviewed","verdict":"approve"}',
      });
      await vi.advanceTimersByTimeAsync(1);

      expect(await promise).toMatchObject({
        kind: "review",
        reviewResult: { summary: "Reviewed", verdict: "approve" },
      });
      expect(session.hydrate).toHaveBeenCalledTimes(2);
      expect(session.info).toHaveBeenCalledTimes(3);
    });

    it("waits for a latest review while active even if an older review exists", async () => {
      const events = [
        {
          type: "agentMessaged",
          message: '{"summary":"Old","verdict":"approve"}',
        },
        { type: "agentMessaged", message: "Checking one more file" },
      ];
      const session = mockSession(events);
      vi.spyOn(jules, "with").mockReturnValue({
        ...jules,
        session: vi.fn().mockResolvedValue(session),
      });
      const promise = runSession(runOptions);
      await vi.advanceTimersByTimeAsync(19_999);
      expect(session.archive).not.toHaveBeenCalled();
      events.push({
        type: "agentMessaged",
        message: '{"summary":"Latest","verdict":"comment"}',
      });
      await vi.advanceTimersByTimeAsync(1);
      expect(await promise).toMatchObject({
        kind: "review",
        reviewResult: { summary: "Latest", verdict: "comment" },
      });
    });

    it("returns timeout at the deadline when only progress messages exist", async () => {
      const events = [{ type: "agentMessaged", message: "Initial progress" }];
      const session = mockSession(events);
      vi.spyOn(jules, "with").mockReturnValue({
        ...jules,
        session: vi.fn().mockResolvedValue(session),
      });
      const promise = runSession(runOptions);
      await vi.advanceTimersByTimeAsync(20_000);
      events.push({ type: "agentMessaged", message: "Latest progress" });
      await vi.advanceTimersByTimeAsync(39_999);
      expect(session.archive).not.toHaveBeenCalled();
      expect(core.error).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      expect(await promise).toEqual({ kind: "timeout", sessionId: session.id });
      expect(core.info).toHaveBeenCalledWith("Collected review (0 chars)");
      expect(core.error).not.toHaveBeenCalled();
      expect(session.archive).toHaveBeenCalledTimes(1);
    });

    it("returns timeout after progress followed by polling errors", async () => {
      const session = mockSession([
        { type: "agentMessaged", message: "Progress" },
      ]);
      session.hydrate
        .mockResolvedValueOnce(1)
        .mockRejectedValue(new Error("temporary failure"));
      vi.spyOn(jules, "with").mockReturnValue({
        ...jules,
        session: vi.fn().mockResolvedValue(session),
      });
      const promise = runSession(runOptions);
      await vi.advanceTimersByTimeAsync(59_999);
      expect(session.archive).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(await promise).toEqual({ kind: "timeout", sessionId: session.id });
      expect(session.hydrate).toHaveBeenCalledTimes(3);
    });

    it.each(["completed", "failed"])(
      "returns the newest parseable review after two terminal polls: %s",
      async (state) => {
        const session = mockSession([
          {
            type: "agentMessaged",
            message: '{"summary":"Old","verdict":"approve"}',
          },
          {
            type: "agentMessaged",
            message: '{"summary":"Newest","verdict":"comment"}',
          },
          {
            type: "agentMessaged",
            message: "Let me know if you need anything else",
          },
          { type: "progressUpdated", message: "Done" },
        ]);
        session.info.mockResolvedValue({ state });
        vi.spyOn(jules, "with").mockReturnValue({
          ...jules,
          session: vi.fn().mockResolvedValue(session),
        });
        const promise = runSession(runOptions);
        await vi.advanceTimersByTimeAsync(19_999);
        expect(session.archive).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(session.archive).toHaveBeenCalledTimes(1);
        expect(await promise).toMatchObject({
          kind: "review",
          reviewResult: { summary: "Newest", verdict: "comment" },
        });
        expect(session.hydrate).toHaveBeenCalledTimes(2);
        expect(session.info).toHaveBeenCalledTimes(3);
      }
    );

    it.each(["completed", "failed"])(
      "asks once, then returns a parse failure for a finished non-review: %s",
      async (state) => {
        const events = [{ type: "agentMessaged", message: "Progress" }];
        const session = mockSession(events);
        session.info.mockResolvedValue({ state });
        vi.spyOn(jules, "with").mockReturnValue({
          ...jules,
          session: vi.fn().mockResolvedValue(session),
        });
        const promise = runSession(runOptions);
        await vi.advanceTimersByTimeAsync(19_999);
        expect(session.send).not.toHaveBeenCalled();
        events.push({
          type: "agentMessaged",
          message: "Finished without JSON",
        });
        await vi.advanceTimersByTimeAsync(1);
        expect(session.send).toHaveBeenCalledTimes(1);
        expect(session.archive).not.toHaveBeenCalled();
        // No reply: the follow-up wait ends at the 1-minute deadline.
        await vi.advanceTimersByTimeAsync(40_000);
        expect(session.archive).toHaveBeenCalledTimes(1);
        expect(await promise).toMatchObject({
          kind: "review",
          reviewResult: { unparseable: true },
        });
        expect(core.info).toHaveBeenCalledWith("Collected review (21 chars)");
      }
    );

    describe("follow-up when Jules finishes without a review", () => {
      const review = '{"summary":"Reviewed","verdict":"comment"}';
      const start = (events: any[], timeoutMinutes = 45) => {
        const session = mockSession(events);
        session.info.mockResolvedValue({ state: "completed" });
        // The API records a sent message as a userMessaged activity.
        session.send.mockImplementation(async (message: string) => {
          events.push({ type: "userMessaged", message });
        });
        vi.spyOn(jules, "with").mockReturnValue({
          ...jules,
          session: vi.fn().mockResolvedValue(session),
        });
        const promise = runSession({ ...runOptions, timeoutMinutes });
        return { session, promise };
      };

      it("asks the same session once and uses the review it sends back", async () => {
        const events: any[] = [
          { type: "agentMessaged", message: "I have completed the review." },
        ];
        const { session, promise } = start(events);
        await vi.advanceTimersByTimeAsync(20_000);
        expect(session.send).toHaveBeenCalledTimes(1);
        const [prompt] = session.send.mock.calls[0];
        expect(prompt).toContain("Your last message was not the review.");
        expect(prompt).toContain("Output format (STRICT JSON)");
        expect(session.archive).not.toHaveBeenCalled();

        events.push({ type: "agentMessaged", message: review });
        await vi.advanceTimersByTimeAsync(20_000);

        expect(await promise).toMatchObject({
          kind: "review",
          reviewResult: { summary: "Reviewed", verdict: "comment" },
        });
        expect(session.send).toHaveBeenCalledTimes(1);
        expect(session.archive).toHaveBeenCalledTimes(1);
      });

      it("waits through a terminal state until the reply arrives", async () => {
        const events: any[] = [
          { type: "agentMessaged", message: "I have completed the review." },
        ];
        const { session, promise } = start(events);
        // The state stays "completed" the whole time: before the reply it says
        // nothing about whether Jules has answered the follow-up yet.
        await vi.advanceTimersByTimeAsync(20_000 + 3 * 60_000);
        expect(session.archive).not.toHaveBeenCalled();

        events.push({ type: "agentMessaged", message: review });
        await vi.advanceTimersByTimeAsync(20_000);

        expect(await promise).toMatchObject({
          kind: "review",
          reviewResult: { verdict: "comment" },
        });
      });

      it("returns the parse failure when the reply is not a review either", async () => {
        const events: any[] = [
          { type: "agentMessaged", message: "I have completed the review." },
        ];
        const { session, promise } = start(events);
        await vi.advanceTimersByTimeAsync(20_000);
        events.push({ type: "agentMessaged", message: "Done, see above." });
        await vi.advanceTimersByTimeAsync(60_000);

        expect(await promise).toMatchObject({
          kind: "review",
          reviewResult: { unparseable: true },
        });
        expect(session.send).toHaveBeenCalledTimes(1);
        expect(core.info).toHaveBeenCalledWith("Collected review (16 chars)");
      });

      it("gives up 10 minutes after the follow-up when nothing comes back", async () => {
        const { session, promise } = start([
          { type: "agentMessaged", message: "I have completed the review." },
        ]);
        await vi.advanceTimersByTimeAsync(20_000);
        expect(session.send).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(9 * 60_000);
        expect(session.archive).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(60_000);

        expect(session.archive).toHaveBeenCalledTimes(1);
        expect(await promise).toMatchObject({
          kind: "review",
          reviewResult: { unparseable: true },
        });
        expect(core.info).toHaveBeenCalledWith("Collected review (28 chars)");
        // 2 polls, 1 read before the follow-up, then one read every 20 s
        // for exactly 10 minutes: none past the window.
        expect(session.hydrate).toHaveBeenCalledTimes(2 + 1 + 30);
      });

      it("returns the parse failure when the follow-up cannot be sent", async () => {
        const { session, promise } = start([
          { type: "agentMessaged", message: "I have completed the review." },
        ]);
        session.send.mockRejectedValue(
          new Error("[429 Too Many Requests] POST .../sessions/1:sendMessage")
        );
        await vi.advanceTimersByTimeAsync(20_000);

        expect(await promise).toMatchObject({
          kind: "review",
          reviewResult: { unparseable: true },
        });
        expect(core.warning).toHaveBeenCalledWith(
          expect.stringContaining("Could not ask Jules for the review")
        );
        // A 429 means the message was not stored: no wait for a reply.
        expect(session.hydrate).toHaveBeenCalledTimes(3);
      });

      it("uses a review that lands just before the follow-up, without asking", async () => {
        const events: any[] = [
          { type: "agentMessaged", message: "I have completed the review." },
        ];
        const { session, promise } = start(events);
        let reads = 0;
        session.hydrate.mockImplementation(async () => {
          // Two polls reach the terminal stop; the third read is the one
          // taken right before the follow-up would go out.
          if (++reads === 3)
            events.push({ type: "agentMessaged", message: review });
          return 1;
        });
        await vi.advanceTimersByTimeAsync(20_000);

        expect(await promise).toMatchObject({
          kind: "review",
          reviewResult: { verdict: "comment" },
        });
        expect(session.send).not.toHaveBeenCalled();
      });

      it("ignores a message that lands during the follow-up but before it", async () => {
        const events: any[] = [
          { type: "agentMessaged", message: "I have completed the review." },
        ];
        const { session, promise } = start(events);
        session.send.mockImplementation(async (message: string) => {
          // A late message from the original task is ordered before the request.
          events.push({ type: "agentMessaged", message: "Late note." });
          events.push({ type: "userMessaged", message });
        });
        await vi.advanceTimersByTimeAsync(20_000);
        expect(session.send).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(3 * 60_000);
        expect(session.archive).not.toHaveBeenCalled();

        events.push({ type: "agentMessaged", message: review });
        await vi.advanceTimersByTimeAsync(20_000);
        expect(await promise).toMatchObject({
          kind: "review",
          reviewResult: { verdict: "comment" },
        });
      });

      it("anchors the reply on the request even when the reads before it failed", async () => {
        const events: any[] = [{ type: "agentMessaged", message: "Progress" }];
        const { session, promise } = start(events);
        let reads = 0;
        session.hydrate.mockImplementation(async () => {
          reads++;
          if (reads === 2) {
            events.push({
              type: "agentMessaged",
              message: "I have completed the review.",
            });
          }
          // The last poll's read and the read before the follow-up both fail.
          if (reads === 2 || reads === 3)
            throw new Error("history unavailable");
          return 1;
        });
        await vi.advanceTimersByTimeAsync(20_000);
        expect(session.send).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(3 * 60_000);
        expect(session.archive).not.toHaveBeenCalled();

        events.push({ type: "agentMessaged", message: review });
        await vi.advanceTimersByTimeAsync(20_000);
        expect(await promise).toMatchObject({
          kind: "review",
          reviewResult: { verdict: "comment" },
        });
      });

      it("throws an auth error when the follow-up is rejected with 401", async () => {
        const { session, promise } = start([
          { type: "agentMessaged", message: "I have completed the review." },
        ]);
        session.send.mockRejectedValue(
          new Error("[401 Unauthorized] POST .../sessions/1:sendMessage")
        );
        const settled = promise.catch((err: unknown) => err);
        await vi.advanceTimersByTimeAsync(20_000);

        expect(await settled).toBeInstanceOf(AuthError);
        expect(session.archive).toHaveBeenCalledTimes(1);
      });

      it("keeps waiting after an unclear send failure, in case the request arrived", async () => {
        const events: any[] = [
          { type: "agentMessaged", message: "I have completed the review." },
        ];
        const { session, promise } = start(events);
        session.send.mockImplementation(async (message: string) => {
          events.push({ type: "userMessaged", message });
          throw new Error("fetch failed: socket hang up");
        });
        await vi.advanceTimersByTimeAsync(20_000);
        expect(core.warning).toHaveBeenCalledWith(
          expect.stringContaining("may have arrived")
        );
        events.push({ type: "agentMessaged", message: review });
        await vi.advanceTimersByTimeAsync(20_000);

        expect(await promise).toMatchObject({
          kind: "review",
          reviewResult: { verdict: "comment" },
        });
      });

      it("starts the 10-minute window when the follow-up has been sent", async () => {
        const { session, promise } = start([
          { type: "agentMessaged", message: "I have completed the review." },
        ]);
        session.send.mockImplementation(
          () => new Promise((resolve) => setTimeout(resolve, 2 * 60_000))
        );
        await vi.advanceTimersByTimeAsync(20_000 + 2 * 60_000 + 9 * 60_000);
        expect(session.archive).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(60_000);

        expect(session.archive).toHaveBeenCalledTimes(1);
        expect(await promise).toMatchObject({
          kind: "review",
          reviewResult: { unparseable: true },
        });
      });

      it("does not ask when less than one poll interval is left", async () => {
        const { session, promise } = start(
          [{ type: "agentMessaged", message: "I have completed the review." }],
          0.5
        );
        await vi.advanceTimersByTimeAsync(20_000);

        expect(await promise).toMatchObject({
          kind: "review",
          reviewResult: { unparseable: true },
        });
        expect(session.send).not.toHaveBeenCalled();
      });

      it("does not ask when the session finished without any message", async () => {
        const { session, promise } = start([], 1);
        await vi.advanceTimersByTimeAsync(20_000);

        expect(await promise).toEqual({
          kind: "timeout",
          sessionId: "test-session-id",
        });
        expect(session.send).not.toHaveBeenCalled();
      });

      it("does not ask when a review already arrived", async () => {
        const { session, promise } = start([
          { type: "agentMessaged", message: review },
        ]);

        expect(await promise).toMatchObject({ kind: "review" });
        expect(session.send).not.toHaveBeenCalled();
      });
    });

    it.each(["inProgress", "info error"])(
      "resets consecutive terminal polls on %s",
      async (interruption) => {
        const session = mockSession([
          { type: "agentMessaged", message: "Done" },
        ]);
        session.info
          .mockResolvedValueOnce({ state: "completed" }) // readiness is not a poll
          .mockResolvedValueOnce({ state: "completed" });
        if (interruption === "info error") {
          session.info.mockRejectedValueOnce(new Error("info unavailable"));
        } else {
          session.info.mockResolvedValueOnce({ state: interruption });
        }
        session.info.mockResolvedValue({ state: "failed" });
        vi.spyOn(jules, "with").mockReturnValue({
          ...jules,
          session: vi.fn().mockResolvedValue(session),
        });
        const promise = runSession({ ...runOptions, timeoutMinutes: 2 });
        // The terminal stop is where the follow-up goes out: at 60 s, not at
        // 40 s, because the interruption reset the count.
        await vi.advanceTimersByTimeAsync(59_999);
        expect(session.send).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(session.send).toHaveBeenCalledTimes(1);
        expect(session.info).toHaveBeenCalledTimes(5);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(await promise).toMatchObject({
          kind: "review",
          reviewResult: { unparseable: true },
        });
      }
    );

    it("returns the most recent parseable review at the deadline despite a trailing note and later errors", async () => {
      const session = mockSession([
        {
          type: "agentMessaged",
          message: '{"summary":"Old","verdict":"approve"}',
        },
        {
          type: "agentMessaged",
          message: '{"summary":"Newest","verdict":"comment"}',
        },
        {
          type: "agentMessaged",
          message: "Let me know if you need anything else",
        },
      ]);
      session.hydrate
        .mockResolvedValueOnce(1)
        .mockRejectedValue(new Error("temporary failure"));
      vi.spyOn(jules, "with").mockReturnValue({
        ...jules,
        session: vi.fn().mockResolvedValue(session),
      });
      const promise = runSession(runOptions);
      await vi.advanceTimersByTimeAsync(59_999);
      expect(session.archive).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(await promise).toMatchObject({
        kind: "review",
        reviewResult: { summary: "Newest", verdict: "comment" },
      });
    });

    it("retries a progress-only timeout with a fresh prompt-mode session", async () => {
      const first = mockSession([
        { type: "agentMessaged", message: "Still reviewing" },
      ]);
      const second = mockSession([
        {
          type: "agentMessaged",
          message: '{"summary":"Retry","verdict":"approve"}',
        },
      ]);
      const create = vi
        .fn()
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(second);
      vi.spyOn(jules, "with").mockReturnValue({ ...jules, session: create });
      const promise = runJulesReview("api-key", "prompt", runOptions.source, 1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await promise).toMatchObject({
        reviewResult: { summary: "Retry" },
      });
      expect(create).toHaveBeenCalledTimes(2);
      expect(first.archive).toHaveBeenCalledTimes(1);
    });

    it("falls back from agentic mode on a progress-only timeout", async () => {
      const session = mockSession([
        { type: "agentMessaged", message: "Still reviewing" },
      ]);
      vi.spyOn(jules, "with").mockReturnValue({
        ...jules,
        session: vi.fn().mockResolvedValue(session),
      });
      const promise = runAgenticReview(
        "api-key",
        "prompt",
        runOptions.source,
        1
      );
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await promise).toMatchObject({
        fallback: true,
        fallbackReason: "timeout",
        reviewResult: null,
      });
    });

    it("returns a timeout outcome when no message arrives before the deadline", async () => {
      const session = mockSession([]);
      (jules as any).with = vi.fn().mockReturnValue({
        session: vi.fn().mockResolvedValue(session),
      });

      const promise = runSession(runOptions);
      await vi.advanceTimersByTimeAsync(61 * 1000);

      const result = await promise;
      expect(result).toEqual({ kind: "timeout", sessionId: "test-session-id" });
      expect(session.archive).toHaveBeenCalled();
    });

    it("returns a creation_failed outcome when session creation throws", async () => {
      const boom = new Error("session create exploded");
      (jules as any).with = vi.fn().mockReturnValue({
        session: vi.fn().mockRejectedValue(boom),
      });

      const result = await runSession(runOptions);

      expect(result).toEqual({
        kind: "creation_failed",
        sessionId: "",
        error: boom,
      });
    });

    it("wraps a quota error from session creation in QuotaExceededError", async () => {
      (jules as any).with = vi.fn().mockReturnValue({
        session: vi
          .fn()
          .mockRejectedValue(new Error("status code 429 quota exceeded")),
      });

      const promise = runSession(runOptions);
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      const result = await promise;

      expect(result.kind).toBe("creation_failed");
      if (result.kind === "creation_failed") {
        expect(result.error).toBeInstanceOf(QuotaExceededError);
        // Every plan's daily limit, not only the free tier's (#20).
        expect((result.error as Error).message).toContain(
          "15 on the free plan, 100 on Pro, 300 on Ultra"
        );
      }
    });

    it.each(creationRefusals)(
      "retries $description at 5, 10, 15 and 30 minutes and then succeeds",
      async ({ message, description }) => {
        const session = mockSession([
          { type: "agentMessaged", message: '{"verdict":"approve"}' },
        ]);
        const createSession = vi
          .fn()
          .mockRejectedValueOnce(new Error(message))
          .mockRejectedValueOnce(new Error(message))
          .mockRejectedValueOnce(new Error(message))
          .mockRejectedValueOnce(new Error(message))
          .mockResolvedValue(session);
        vi.spyOn(jules, "with").mockReturnValue({
          ...jules,
          session: createSession,
        });

        const promise = runSession(runOptions);
        await vi.advanceTimersByTimeAsync(0);
        const waits = [5, 5, 5, 15];
        for (const [index, minutes] of waits.entries()) {
          expect(createSession).toHaveBeenCalledTimes(index + 1);
          expect(core.warning).toHaveBeenNthCalledWith(
            index + 1,
            `Jules API returned ${description}; retrying in ${minutes} minutes (retry ${index + 1} of 4)`
          );
          const retryLogs = vi
            .mocked(core.info)
            .mock.calls.map(([line]) => line)
            .filter((line) => line.includes('"event":"jules_cap_retry"'));
          expect(retryLogs).toHaveLength(index + 1);
          expect(retryLogs[index]).toContain(
            `"payload":${JSON.stringify({
              retry: index + 1,
              of: 4,
              waitMinutes: minutes,
              status: message === concurrencyCapMessage ? 400 : 429,
            })}`
          );
          await vi.advanceTimersByTimeAsync(minutes * 60_000 - 1);
          expect(createSession).toHaveBeenCalledTimes(index + 1);
          await vi.advanceTimersByTimeAsync(1);
        }

        expect(await promise).toMatchObject({ kind: "review" });
        expect(createSession).toHaveBeenCalledTimes(5);
        expect(core.warning).toHaveBeenCalledTimes(4);
        expect(
          createSession.mock.calls.every(
            ([config]) =>
              JSON.stringify(config) ===
              JSON.stringify(createSession.mock.calls[0][0])
          )
        ).toBe(true);
        expect(session.info).toHaveBeenCalledTimes(2);
        expect(session.archive).toHaveBeenCalledTimes(1);
      }
    );

    it.each(creationRefusals)(
      "stops after four retries for $description with a quota failure",
      async ({ message }) => {
        const error = new Error(message);
        const createSession = vi.fn().mockRejectedValue(error);
        vi.spyOn(jules, "with").mockReturnValue({
          ...jules,
          session: createSession,
        });

        const promise = runSession(runOptions);
        await vi.advanceTimersByTimeAsync(30 * 60_000);
        const result = await promise;

        expect(createSession).toHaveBeenCalledTimes(5);
        expect(core.warning).toHaveBeenCalledTimes(4);
        expect(result.kind).toBe("creation_failed");
        if (result.kind === "creation_failed") {
          expect(result.error).toBeInstanceOf(QuotaExceededError);
          expect(result.error).toHaveProperty("cause", error);
          expect(classifyFailure(result.error).kind).toBe("quota");
          if (message === concurrencyCapMessage) {
            // The 400 doesn't say which limit refused the session (#20).
            const text = (result.error as Error).message;
            expect(text).toContain("daily task limit");
            expect(text).toContain("concurrency cap");
            expect(text).toContain("does not say which");
            expect(text).not.toContain("reduce concurrent reviews");
          }
        }
      }
    );

    it("shares one cap budget across agentic, prompt fallback and timeout retry sessions", async () => {
      const progress = [{ type: "agentMessaged", message: "Still reviewing" }];
      const agentic = mockSession(progress);
      const prompt = mockSession(progress);
      const cap = new Error(concurrencyCapMessage);
      const rateLimit = new Error("[429 Too Many Requests]");
      const create = vi
        .fn()
        .mockRejectedValueOnce(cap)
        .mockRejectedValueOnce(rateLimit)
        .mockResolvedValueOnce(agentic)
        .mockRejectedValueOnce(cap)
        .mockResolvedValueOnce(prompt)
        .mockRejectedValue(rateLimit);
      vi.spyOn(jules, "with").mockReturnValue({ ...jules, session: create });

      const agenticPromise = runAgenticReview(
        "api-key",
        "prompt",
        runOptions.source,
        1
      );
      await vi.advanceTimersByTimeAsync(11 * 60_000);
      expect(await agenticPromise).toMatchObject({
        fallback: true,
        fallbackReason: "timeout",
      });
      expect(create).toHaveBeenCalledTimes(3);

      const promptFailure = runJulesReview(
        "api-key",
        "prompt",
        runOptions.source,
        1
      ).then(
        () => null,
        (error: unknown) => error
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(core.warning).toHaveBeenLastCalledWith(
        expect.stringContaining("retry 3 of 4")
      );
      await vi.advanceTimersByTimeAsync(6 * 60_000);
      expect(create).toHaveBeenCalledTimes(6);
      expect(core.warning).toHaveBeenLastCalledWith(
        expect.stringContaining("retry 4 of 4")
      );
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      expect(await promptFailure).toBeInstanceOf(QuotaExceededError);
      expect(create).toHaveBeenCalledTimes(7);
      expect(core.warning).toHaveBeenCalledTimes(4);
      expect(vi.getTimerCount()).toBe(0);
    });

    it.each(creationRefusals)(
      "fails a later $description refusal immediately after the shared budget is spent",
      async ({ message }) => {
        const session = mockSession([
          { type: "agentMessaged", message: '{"verdict":"approve"}' },
        ]);
        const cap = new Error(message);
        const create = vi
          .fn()
          .mockRejectedValueOnce(cap)
          .mockRejectedValueOnce(cap)
          .mockRejectedValueOnce(cap)
          .mockRejectedValueOnce(cap)
          .mockResolvedValueOnce(session)
          .mockRejectedValue(cap);
        vi.spyOn(jules, "with").mockReturnValue({ ...jules, session: create });
        const first = runSession(runOptions);
        await vi.advanceTimersByTimeAsync(30 * 60_000);
        expect(await first).toMatchObject({ kind: "review" });
        const later = runSession(runOptions);
        await vi.advanceTimersByTimeAsync(0);
        expect(vi.getTimerCount()).toBe(0);
        expect(await later).toMatchObject({
          kind: "creation_failed",
          error: expect.any(QuotaExceededError),
        });
        expect(create).toHaveBeenCalledTimes(6);
        expect(core.warning).toHaveBeenCalledTimes(4);
      }
    );

    it("does not fall back to inline mode after concurrency cap retries are exhausted", async () => {
      const createSession = vi
        .fn()
        .mockRejectedValue(new Error(concurrencyCapMessage));
      vi.spyOn(jules, "with").mockReturnValue({
        ...jules,
        session: createSession,
      });

      const failure = runAgenticReview(
        "api-key",
        "prompt",
        runOptions.source,
        1
      ).then(
        () => null,
        (error: unknown) => error
      );
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      expect(await failure).toBeInstanceOf(QuotaExceededError);

      expect(createSession).toHaveBeenCalledTimes(5);
      expect(core.info).not.toHaveBeenCalledWith(
        expect.stringContaining('"event":"agentic_fallback"')
      );
    });

    it.each([
      "[400 Bad Request] INVALID_ARGUMENT",
      "[400 Bad Request] Precondition check failed.",
      "[500 Internal Server Error] FAILED_PRECONDITION",
      "FAILED_PRECONDITION",
      "quota exceeded",
      "network error",
    ])("does not retry permanent creation errors: %s", async (message) => {
      const error = new Error(message);
      const createSession = vi.fn().mockRejectedValue(error);
      vi.spyOn(jules, "with").mockReturnValue({
        ...jules,
        session: createSession,
      });

      const result = await runSession(runOptions);
      expect(result.kind).toBe("creation_failed");
      expect(createSession).toHaveBeenCalledTimes(1);
      expect(core.warning).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      if (result.kind === "creation_failed" && message !== "quota exceeded") {
        expect(result.error).toBe(error);
      }
    });

    it.each(["info", "hydrate"] as const)(
      "does not map a non-creation FAILED_PRECONDITION from %s to quota",
      async (method) => {
        const session = mockSession([]);
        session[method].mockRejectedValue(new Error(concurrencyCapMessage));
        const createSession = vi.fn().mockResolvedValue(session);
        vi.spyOn(jules, "with").mockReturnValue({
          ...jules,
          session: createSession,
        });

        const failure = runSession(runOptions).then(
          () => null,
          (error: unknown) => error
        );
        await vi.advanceTimersByTimeAsync(60_000);
        const result = await failure;
        expect(result).not.toBeInstanceOf(QuotaExceededError);
        if (method === "info") {
          expect(result).toBeInstanceOf(Error);
          expect(classifyFailure(result).kind).toBe("unknown");
        } else {
          expect(result).toBeNull(); // ordinary hydrate errors keep polling to timeout
        }
        expect(createSession).toHaveBeenCalledTimes(1);
        expect(session.archive).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
      }
    );

    it("wraps an auth error from session creation in AuthError", async () => {
      (jules as any).with = vi.fn().mockReturnValue({
        session: vi.fn().mockRejectedValue(new Error("status code 401")),
      });

      const result = await runSession(runOptions);

      expect(result.kind).toBe("creation_failed");
      if (result.kind === "creation_failed") {
        expect(result.error).toBeInstanceOf(AuthError);
      }
    });

    it("throws an auth error and archives when readiness returns 401", async () => {
      const session = mockSession([]);
      session.info.mockRejectedValue(new Error("status code 401"));
      (jules as any).with = vi.fn().mockReturnValue({
        session: vi.fn().mockResolvedValue(session),
      });

      await expect(runSession(runOptions)).rejects.toThrow(
        "Jules API rejected request"
      );
      expect(session.archive).toHaveBeenCalled();
    });

    it("throws and archives when readiness fails with a non-404 error", async () => {
      const session = mockSession([]);
      session.info.mockRejectedValue(new Error("boom"));
      (jules as any).with = vi.fn().mockReturnValue({
        session: vi.fn().mockResolvedValue(session),
      });

      await expect(runSession(runOptions)).rejects.toThrow(
        "Jules session.info() failed"
      );
      expect(session.archive).toHaveBeenCalled();
    });

    it("waits through 404 responses until the session is ready", async () => {
      const session = mockSession([
        {
          type: "agentMessaged",
          message: '{"summary":"ok","verdict":"comment"}',
        },
      ]);
      session.info
        .mockRejectedValueOnce(new Error("status code 404"))
        .mockResolvedValueOnce({});
      (jules as any).with = vi.fn().mockReturnValue({
        session: vi.fn().mockResolvedValue(session),
      });

      const promise = runSession(runOptions);
      await vi.advanceTimersByTimeAsync(2000);

      const result = await promise;
      expect(result.kind).toBe("review");
      expect(session.info).toHaveBeenCalledTimes(3);
    });

    it("throws when the session never becomes ready", async () => {
      const session = mockSession([]);
      session.info.mockRejectedValue(new Error("status code 404"));
      (jules as any).with = vi.fn().mockReturnValue({
        session: vi.fn().mockResolvedValue(session),
      });

      const promise = runSession(runOptions);
      const rejection = expect(promise).rejects.toThrow(
        "Session did not become ready within timeout."
      );
      await vi.advanceTimersByTimeAsync(260 * 1000);
      await rejection;
      expect(session.archive).toHaveBeenCalled();
    });

    it("throws an auth error and archives when polling fails with 401", async () => {
      const session = mockSession([]);
      session.hydrate.mockRejectedValue(new Error("status code 401"));
      (jules as any).with = vi.fn().mockReturnValue({
        session: vi.fn().mockResolvedValue(session),
      });

      await expect(runSession(runOptions)).rejects.toThrow(
        "Jules API rejected request"
      );
      expect(session.archive).toHaveBeenCalled();
    });

    it("throws a QuotaExceededError when polling hits a 429", async () => {
      const session = mockSession([]);
      session.hydrate.mockRejectedValue(new Error("status code 429 quota"));
      (jules as any).with = vi.fn().mockReturnValue({
        session: vi.fn().mockResolvedValue(session),
      });

      await expect(runSession(runOptions)).rejects.toThrow(
        "15 on the free plan, 100 on Pro, 300 on Ultra"
      );
      expect(session.archive).toHaveBeenCalled();
    });

    it("throws a QuotaExceededError when readiness hits a 429", async () => {
      const session = mockSession([]);
      session.info.mockRejectedValue(new Error("status code 429 quota"));
      (jules as any).with = vi.fn().mockReturnValue({
        session: vi.fn().mockResolvedValue(session),
      });

      await expect(runSession(runOptions)).rejects.toThrow(
        "15 on the free plan, 100 on Pro, 300 on Ultra"
      );
      expect(session.archive).toHaveBeenCalled();
    });

    it("keeps polling past non-auth errors until the deadline", async () => {
      const session = mockSession([]);
      session.hydrate.mockRejectedValue(new Error("boom"));
      (jules as any).with = vi.fn().mockReturnValue({
        session: vi.fn().mockResolvedValue(session),
      });

      const promise = runSession(runOptions);
      await vi.advanceTimersByTimeAsync(61 * 1000);

      const result = await promise;
      expect(result.kind).toBe("timeout");
      expect(core.info).toHaveBeenCalledWith(
        expect.stringContaining("hydrate/history error")
      );
    });

    it("still returns the outcome when archiving fails", async () => {
      const session = mockSession([
        {
          type: "agentMessaged",
          message: '{"summary":"ok","verdict":"approve"}',
        },
      ]);
      session.archive.mockRejectedValue(new Error("archive exploded"));
      (jules as any).with = vi.fn().mockReturnValue({
        session: vi.fn().mockResolvedValue(session),
      });

      const result = await runSession(runOptions);

      expect(result.kind).toBe("review");
      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining("Failed to archive session")
      );
    });
  });

  describe("isAuthError", () => {
    it("returns true for 401", () => {
      expect(isAuthError("status code 401")).toBe(true);
    });

    it("returns true for 403", () => {
      expect(isAuthError("status 403 forbidden")).toBe(true);
    });

    it("returns false for other status codes", () => {
      expect(isAuthError("status 404 not found")).toBe(false);
      expect(isAuthError("status 500 server error")).toBe(false);
    });
  });
});
