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

    const deadline = Date.now() + options.timeoutMinutes * 60 * 1000;
    const polled = await pollForReview(session as PollableSession, deadline);
    let reviewMessage = polled.review;
    if (polled.finishedWithoutReview) {
      reviewMessage =
        (await askForReview(
          session as PollableSession,
          polled.messageCount,
          deadline
        )) || polled.last;
    }
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

const POLL_INTERVAL_MS = 20_000;

interface PollResult {
  /** The review to parse; "" when none was collected. */
  review: string;
  /** The latest agentMessaged, review or not. */
  last: string;
  /** How many agentMessaged activities the history held at the end. */
  messageCount: number;
  /** The session reached a terminal state, sent messages, and none is a review. */
  finishedWithoutReview: boolean;
}

/** Reads every agentMessaged in the session's history, oldest first. */
async function agentMessages(session: PollableSession): Promise<string[]> {
  await session.hydrate();
  const messages: string[] = [];
  for await (const a of session.history()) {
    if (a.type === "agentMessaged") messages.push(a.message);
  }
  return messages;
}

function isReview(message: string): boolean {
  try {
    parseReviewResponse(message);
    return true;
  } catch {
    return false;
  }
}

async function pollForReview(
  session: PollableSession,
  deadline: number
): Promise<PollResult> {
  let attempt = 0;
  let messageCount = 0;
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
      const messages = await agentMessages(session);
      messageCount = messages.length;
      last = messages[messages.length - 1] ?? "";
      // Latest reviews return immediately; older reviews are retained only
      // for a terminal session or the deadline, in case a note trails them.
      // Progress messages and trailing notes are not reviews.
      for (let i = messages.length - 1; i >= 0; i--) {
        if (!isReview(messages[i])) continue;
        mostRecentReview = messages[i];
        if (i === messages.length - 1) {
          core.info(`Got review on attempt ${attempt}.`);
          return {
            review: mostRecentReview,
            last,
            messageCount,
            finishedWithoutReview: false,
          };
        }
        break;
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
    if (terminalPolls >= 2) {
      // A finished session with no message at all yields "", like a timeout,
      // and gets the same fresh-session retry. One that sent only non-reviews
      // is asked once more by the caller.
      return {
        review: mostRecentReview,
        last,
        messageCount,
        finishedWithoutReview: !mostRecentReview && last !== "",
      };
    }
    await sleep(POLL_INTERVAL_MS);
  }
  // "" means no review was collected; the caller treats it as a timeout.
  return {
    review: mostRecentReview,
    last,
    messageCount,
    finishedWithoutReview: false,
  };
}

const FOLLOW_UP_WINDOW_MS = 10 * 60_000;
const FOLLOW_UP_PROMPT =
  'Your last message was not the review. Output the review now: one JSON object in the format given under "Output format (STRICT JSON)", in a single ```json block, and nothing else.';

/**
 * Asks a session that finished without a review for it, once, and waits for
 * a reply that arrives after the request. Returns the reply, or "" when none
 * came. Session state is not a reply signal (a finished session can report
 * "completed" before it answers a follow-up), so it only ends the wait once
 * a reply exists.
 */
async function askForReview(
  session: PollableSession,
  seen: number,
  deadline: number
): Promise<string> {
  const until = Math.min(deadline, Date.now() + FOLLOW_UP_WINDOW_MS);
  // A follow-up needs at least one poll before the deadline to be read.
  if (until - Date.now() < POLL_INTERVAL_MS) return "";
  // Read once more before asking: the last poll's history read may have
  // failed or lagged, and a reply must be counted from what existed here.
  try {
    const messages = await agentMessages(session);
    const review = [...messages].reverse().find(isReview);
    if (review) return review;
    seen = messages.length;
  } catch (err) {
    const wrapped = wrapJulesError(err);
    if (wrapped) throw wrapped;
  }
  try {
    await session.send(FOLLOW_UP_PROMPT);
  } catch (err) {
    core.warning(`Could not ask Jules for the review: ${getErrorMessage(err)}`);
    return "";
  }
  core.info("Jules finished without a review; asked the same session for it.");
  logStructured("review_follow_up", { sessionId: session.id });

  let reply = "";
  let terminalPolls = 0;
  let attempt = 0;
  while (Date.now() < until) {
    await sleep(POLL_INTERVAL_MS);
    attempt++;
    try {
      const fresh = (await agentMessages(session)).slice(seen);
      reply = fresh[fresh.length - 1] ?? "";
      const review = [...fresh].reverse().find(isReview);
      if (review) return review;
    } catch (err) {
      const wrapped = wrapJulesError(err);
      if (wrapped) throw wrapped;
      core.info(
        `hydrate/history error (follow-up attempt ${attempt}): ${getErrorMessage(err)}`
      );
    }
    try {
      const { state } = await session.info();
      terminalPolls =
        reply && (state === "completed" || state === "failed")
          ? terminalPolls + 1
          : 0;
    } catch {
      terminalPolls = 0;
    }
    if (terminalPolls >= 2) return reply;
    core.info(
      reply
        ? `No valid review in the reply yet (follow-up attempt ${attempt})…`
        : `No reply yet (follow-up attempt ${attempt})…`
    );
  }
  return reply;
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
