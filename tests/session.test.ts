/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runSession } from "../src/session.js";
import { runAgenticReview } from "../src/jules.js";
import { classifyFailure } from "../src/errors.js";
import { isAuthError, QuotaExceededError, AuthError } from "../src/errors.js";
import { jules } from "@google/jules-sdk";
import * as core from "@actions/core";

vi.mock("@actions/core");

const mockSession = (historyEvents: any[]) => {
  return {
    id: "test-session-id",
    info: vi.fn().mockResolvedValue({}),
    hydrate: vi.fn().mockResolvedValue(1),
    archive: vi.fn().mockResolvedValue(undefined),
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
      "HTTP 400 FAILED_PRECONDITION (the account may be at its concurrency cap)",
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
      session.info.mockResolvedValue({ state: "COMPLETED" });
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
      expect(session.info).toHaveBeenCalledTimes(1);
    });

    it("waits for the latest message to be a review even if an older review exists", async () => {
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

    it("returns the latest invalid message at the deadline for the parse-failure path", async () => {
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

      expect(await promise).toMatchObject({
        kind: "review",
        reviewResult: { unparseable: true, verdict: "block" },
      });
      expect(core.info).toHaveBeenCalledWith("Collected review (15 chars)");
      expect(session.archive).toHaveBeenCalledTimes(1);
    });

    it("preserves the last message through later polling errors until the deadline", async () => {
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
      expect(await promise).toMatchObject({
        kind: "review",
        reviewResult: { unparseable: true },
      });
      expect(session.hydrate).toHaveBeenCalledTimes(3);
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
        expect((result.error as Error).message).toContain(
          "15 sessions per 24 hours"
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
        expect(session.info).toHaveBeenCalledTimes(1);
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
            expect(result.error).toHaveProperty(
              "message",
              expect.stringContaining("concurrency cap")
            );
          }
        }
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
      "does not retry session creation when %s hits the concurrency cap",
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
        expect(await failure).toBeInstanceOf(QuotaExceededError);
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
      expect(session.info).toHaveBeenCalledTimes(2);
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

      await expect(runSession(runOptions)).rejects.toThrow("15 sessions");
      expect(session.archive).toHaveBeenCalled();
    });

    it("throws a QuotaExceededError when readiness hits a 429", async () => {
      const session = mockSession([]);
      session.info.mockRejectedValue(new Error("status code 429 quota"));
      (jules as any).with = vi.fn().mockReturnValue({
        session: vi.fn().mockResolvedValue(session),
      });

      await expect(runSession(runOptions)).rejects.toThrow("15 sessions");
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
