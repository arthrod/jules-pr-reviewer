import * as core from "@actions/core";
import { jules, type SessionClient, type SourceInput } from "@google/jules-sdk";
import { ReviewResult } from "./types.js";
import { parseReviewResponse } from "./validation.js";
import {
  getErrorMessage,
  isAuthError,
  isConcurrencyCapError,
  isQuotaError,
  AuthError,
  QuotaExceededError,
  QUOTA_HINT,
} from "./errors.js";
import { logStructured } from "./logging.js";
import { sleep } from "./utils.js";

type PollableSession = SessionClient & { hydrate: () => Promise<number> };

const PARSE_FAILURE_REVIEW: ReviewResult = {
  summary:
    "Jules returned an invalid response that could not be parsed. No valid code review comments are present.",
  verdict: "block",
  resolvedCommentIds: [],
  newComments: [],
  unparseable: true,
};

export type SessionOutcome =
  | { kind: "review"; reviewResult: ReviewResult; sessionId: string }
  | { kind: "timeout"; sessionId: string }
  | { kind: "creation_failed"; sessionId: ""; error: unknown };

export interface RunSessionOptions {
  apiKey: string;
  prompt: string;
  source: SourceInput;
  title: string;
  timeoutMinutes: number;
}

/**
 * The SDK caches sessions (including the full prompt) under JULES_HOME, else
 * the cwd or $HOME. RUNNER_TEMP is emptied for every job, so self-hosted
 * runners don't accumulate PR diffs across jobs.
 */
function keepSdkCacheInRunnerTemp(): void {
  if (!process.env.JULES_HOME && process.env.RUNNER_TEMP) {
    process.env.JULES_HOME = process.env.RUNNER_TEMP;
  }
}

export async function runSession(
  options: RunSessionOptions
): Promise<SessionOutcome> {
  keepSdkCacheInRunnerTemp();
  const customJules = jules.with({ apiKey: options.apiKey });
  core.info("Creating Jules session…");

  let session: SessionClient;
  try {
    session = await createSessionWithRetry(() =>
      customJules.session({
        prompt: options.prompt,
        source: options.source,
        requireApproval: false,
        title: options.title,
        autoPr: false,
      })
    );
  } catch (err) {
    return {
      kind: "creation_failed",
      sessionId: "",
      error: wrapJulesError(err) ?? err,
    };
  }
  core.info(`Jules session: ${session.id}`);

  try {
    await waitUntilSessionReady(session);

    const reviewMessage = await pollForReview(
      session as PollableSession,
      options.timeoutMinutes * 60 * 1000
    );
    core.info(`Collected review (${reviewMessage.length} chars)`);

    if (!reviewMessage) {
      await archiveSession(session);
      return { kind: "timeout", sessionId: session.id };
    }

    let reviewResult: ReviewResult;
    try {
      reviewResult = parseReviewResponse(reviewMessage);
    } catch (err) {
      const msg = getErrorMessage(err);
      logStructured("review_failed", {
        reason: msg,
        stage: "parse",
        kind: "parse",
      });
      core.error(`Failed to parse Jules response: ${msg}`);
      await archiveSession(session);
      return {
        kind: "review",
        reviewResult: PARSE_FAILURE_REVIEW,
        sessionId: session.id,
      };
    }

    await archiveSession(session);
    return { kind: "review", reviewResult, sessionId: session.id };
  } catch (err) {
    await archiveSession(session);
    throw err;
  }
}

// One creation-cap retry budget for the entire action process, including
// agentic fallback and fresh-session timeout retries. Successful creates do
// not replenish it. The waits total 30 minutes across all calls.
const CAP_RETRY_WAITS_MINUTES = [5, 5, 5, 15];
let capRetriesUsed = 0;

/** Reset process-wide retry state between tests only. */
export function resetCapRetryBudgetForTests(): void {
  capRetriesUsed = 0;
}

async function createSessionWithRetry(
  create: () => Promise<SessionClient>
): Promise<SessionClient> {
  for (;;) {
    try {
      return await create();
    } catch (err) {
      const message = getErrorMessage(err);
      const concurrencyCap = isConcurrencyCapError(message);
      if (!concurrencyCap && !/\b429\b/.test(message)) throw err;
      if (capRetriesUsed === CAP_RETRY_WAITS_MINUTES.length) {
        if (concurrencyCap) {
          throw new QuotaExceededError(
            `Jules API concurrency cap reached (${message}). Wait for active sessions to finish or reduce concurrent reviews.`,
            { cause: err }
          );
        }
        throw err;
      }
      const minutes = CAP_RETRY_WAITS_MINUTES[capRetriesUsed++];
      const description = concurrencyCap
        ? "HTTP 400 FAILED_PRECONDITION (the account may be at its concurrency cap)"
        : "HTTP 429 (quota or rate limit exceeded)";
      core.warning(
        `Jules API returned ${description}; retrying in ${minutes} minutes (retry ${capRetriesUsed} of 4)`
      );
      logStructured("jules_cap_retry", {
        retry: capRetriesUsed,
        of: 4,
        waitMinutes: minutes,
        status: concurrencyCap ? 400 : 429,
      });
      await sleep(minutes * 60_000);
    }
  }
}

async function waitUntilSessionReady(session: {
  id: string;
  info: () => Promise<unknown>;
}): Promise<void> {
  const maxAttempts = 20;
  let delay = 2000;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      await session.info();
      core.info(`Session ${session.id} is ready after ${i + 1} attempt(s).`);
      return;
    } catch (err) {
      const wrapped = wrapJulesError(err);
      if (wrapped) throw wrapped;
      const msg = getErrorMessage(err);
      if (!msg.includes("404")) {
        throw new Error(`Jules session.info() failed: ${msg}`, { cause: err });
      }
      core.info(`Session not yet ready (attempt ${i + 1}/${maxAttempts})…`);
      await sleep(delay);
      delay = Math.min(delay * 1.5, 15000);
    }
  }
  throw new Error("Session did not become ready within timeout.");
}

async function pollForReview(
  session: PollableSession,
  timeoutMs: number
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  let last = "";
  let mostRecentReview = "";
  let terminalPolls = 0;
  while (Date.now() < deadline) {
    attempt++;
    try {
      const { state } = await session.info();
      terminalPolls =
        state === "completed" || state === "failed" ? terminalPolls + 1 : 0;
    } catch (err) {
      terminalPolls = 0;
      core.info(
        `Session state unavailable (attempt ${attempt}): ${getErrorMessage(err)}`
      );
    }
    try {
      await session.hydrate();
      const messages: string[] = [];
      for await (const a of session.history()) {
        if (a.type === "agentMessaged") {
          last = a.message;
          messages.push(a.message);
        }
      }
      // Latest reviews return immediately; older reviews are retained only
      // for a terminal session or the deadline, in case a note trails them.
      for (let i = messages.length - 1; i >= 0; i--) {
        try {
          parseReviewResponse(messages[i]);
          mostRecentReview = messages[i];
          if (i === messages.length - 1) {
            core.info(`Got review on attempt ${attempt}.`);
            return mostRecentReview;
          }
          break;
        } catch {
          // Progress messages and trailing notes are not reviews.
        }
      }
      core.info(
        last
          ? `No valid review yet (attempt ${attempt})…`
          : `No agentMessaged yet (attempt ${attempt})…`
      );
    } catch (err) {
      const wrapped = wrapJulesError(err);
      if (wrapped) throw wrapped;
      core.info(
        `hydrate/history error (attempt ${attempt}): ${getErrorMessage(err)}`
      );
    }
    if (terminalPolls >= 2) return mostRecentReview || last;
    await sleep(20_000);
  }
  // An empty string is exclusively the timeout signal to the caller.
  return mostRecentReview;
}

/** Wrap a Jules API error in an actionable typed error, or return null. */
function wrapJulesError(err: unknown): QuotaExceededError | AuthError | null {
  const msg = getErrorMessage(err);
  if (isQuotaError(msg)) {
    return new QuotaExceededError(quotaMessage(msg), { cause: err });
  }
  if (isAuthError(msg)) {
    return new AuthError(authMessage(msg), { cause: err });
  }
  return null;
}

function quotaMessage(msg: string): string {
  return `Jules API quota or rate limit exceeded (${msg}). ${QUOTA_HINT}`;
}

function authMessage(msg: string): string {
  return `Jules API rejected request (${msg}). Check JULES_API_KEY is valid.`;
}

async function archiveSession(session: {
  id: string;
  archive: () => Promise<void>;
}): Promise<void> {
  try {
    await session.archive();
    core.info(`Archived session ${session.id}.`);
  } catch (err) {
    core.warning(
      `Failed to archive session ${session.id}: ${getErrorMessage(err)}`
    );
  }
}
