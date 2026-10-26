# Spec: Jules Retry Resilience

## Problem Statement

When Jules times out during review polling, PR authors get nothing after a long wait: the action fails immediately with no recovery mechanism, and the review is lost. Transient Jules outages or slow internal retries cause permanent review loss on PRs that might otherwise have succeeded, forcing manual re-runs.

## Solution

Add single-retry resilience to the Jules review pipeline. When the first session exhausts its `timeoutMinutes` budget without producing a review, the action automatically creates a fresh session with the same prompt and source and runs it with the full timeout budget. A single retry doubles the chance of success during degraded periods. Fresh-session retries are triggered exclusively on timeout — auth errors, parse errors and exhausted readiness 404 loops do not trigger them. Creation-cap refusals have a separate process-wide retry budget described below.

## User Stories

1. As a PR author, I want the review to be retried once when Jules times out, so that a transient outage does not silently lose my review.
2. As a PR author, I want the retry to use the full `timeoutMinutes` budget, so that the second attempt is not unfairly truncated.
3. As a PR author, I want the action to return the review from the second session when the first one times out, so that I get a completed review instead of a failure.
4. As a PR author, I want no retry to happen when the first attempt succeeds, so that reviews are never duplicated or slowed down.
5. As a maintainer, I want auth errors (401/403) to fail immediately without retrying, so that a misconfigured API key surfaces fast rather than being masked by a retry.
6. As a maintainer, I want parse errors to return a fallback review result without retrying, so that invalid LLM output does not spawn a wasteful second session.
7. As a maintainer, I want readiness failures (404 polling loop) to fail without retrying, so that an unreachable session does not get retried pointlessly.
8. As a maintainer, I want the error message to include both session IDs when both attempts time out, so that the failure is auditable.
9. As a maintainer, I want structured logging when a retry is triggered, so that retry activity is machine-readable.
10. As a maintainer, I want no retry-related log events when the first attempt succeeds, so that successful runs stay clean.
11. As a maintainer, I want the retry logic to be internal to the review pipeline, so that no new action inputs or type fields are added.
12. As a PR author, I want the error to indicate that 2 attempts were made when both time out, so that I understand what happened.

## Implementation Decisions

### Retry is internal to the review pipeline

The fresh-session retry lives inside the review-runner module (`jules.ts`); creation-cap retries live in `session.ts`. No new inputs are added to `action.yml`, `index.ts` requires no orchestration changes, and no new fields are added to the shared type definitions. The retry count is fixed at one retry (two total attempts); it is not configurable.

### Timeout is the only fresh-session retry trigger

A timeout is signaled by the polling function returning an empty string (`""`) without a review, normally after exhausting the `timeoutMinutes` budget. Progress messages do not change that signal at the deadline. That deterministic signal is the sole fresh-session retry trigger. Non-timeout failures — auth errors, finished non-review parse errors and exhausted readiness 404 loops — each keep their existing failure path.

### Polling and stop points

Each poll reads `session.info().state` and hydrates the cached activity history. A latest `agentMessaged` that parses as a review returns immediately. When it does not parse, continue polling while active even if an older review exists.

Stop early after two consecutive polls return `completed` or `failed` (lowercase SDK states). This absorbs history lag; a different state or an `info()` exception resets the count. Readiness checks do not count as polls. An `info()` exception during polling is treated as nonterminal and polling continues.

At a terminal stop, scan all `agentMessaged` messages newest first and return the most recent parseable review. If none parses but the session did send messages, ask it once for the review (next section) before falling back to the parse-failure path. Thus a review followed by “Let me know if…” survives, and a finished non-review gets one more chance in the same session. A finished session without any message returns `""` because no answer is available.

At the deadline, return the most recent parseable review if any, retaining previously observed reviews through later history errors. Otherwise return `""` (timeout), never a non-review progress message. This preserves ADR-009's contract: `""` means timeout and drives both the fresh-session retry and agentic fallback. The follow-up below is the only message sent to a session after its prompt.

### Follow-up for a finished non-review

Jules sometimes finishes with a message that is not the review, for example "I have completed the review." with no JSON (#11: jandira-tech/jubarte#2, session 1474209003773085228). A COMPLETED session accepts `sendMessage` and replies (measured in arthrod/jules-el-conejo#20). So at a terminal stop where messages exist but none parses, `runSession` sends one follow-up with `session.send()`: the last message was not the review, and it should output the review now as the JSON object from "Output format (STRICT JSON)", in one `json` block.

Right before sending, it reads the history once more, and a review that landed since the last poll is used without asking. The follow-up is skipped when less than one 20-second poll interval is left before the deadline.

A reply is an `agentMessaged` activity after the request's own `userMessaged` activity in the history, not after a message count. The SDK only appends activities newer than its latest cached one, so anything after the request was written after it. A late message from the original task, or a stale count after a failed read, cannot pass for the reply.

The action polls every 20 seconds. A reply that parses returns at once. Session state ends the wait only after a reply exists, because a finished session can report `completed` before it answers; after that, two consecutive terminal polls return the newest reply. The wait starts once the request is sent, lasts at most 10 minutes, and never passes the `timeout_minutes` deadline (the last sleep is cut short to end on it).

Send failures are classified:

- 401/403 throws `AuthError`, as it does elsewhere.
- A quota error or 429 means the request was not stored (measured at the concurrency cap), so the parse failure follows at once.
- Any other failure may have stored the request, so the action still waits, and the history shows whether it arrived.

If no review comes back, the result is the earlier message on the parse-failure path, as before, not `""`. A structured `review_follow_up` event marks each follow-up.

### Shared creation-cap budget

On session creation only, retry HTTP `400 FAILED_PRECONDITION` (concurrency cap) and HTTP `429` after waits of 5, 5, 5 and 15 minutes. With continuous refusals, the four retries occur at 5, 10, 15 and 30 minutes after the initial refusal.

Maintain one module-level counter in `session.ts`, reset only by an exported test helper. Agentic creation, prompt-mode fallback and fresh-session timeout retry all consume this same budget; successful creates do not reset it. Total action-level retry sleeps cannot exceed 30 minutes across the run. Once spent, any later cap refusal fails immediately.

The SDK already retries `429` and `5xx` internally for up to 5 minutes per request before throwing, so those waits are additional. A `429` is not evidence of a daily cap alone or of a transient condition alone.

After exhaustion, a creation `400 FAILED_PRECONDITION` throws `QuotaExceededError` with the original cause and guidance to wait for active sessions or reduce concurrency. An exhausted creation `429` is rethrown and wrapped by the generic error wrapper as `QuotaExceededError`, also with its original cause, carrying the quota/rate-limit guidance instead. The generic error wrapper and failure classifier must not map a raw `400 FAILED_PRECONDITION` from `info()` or `hydrate()` to quota. Typed creation errors supply the quota classification. Exhausted quota failures bypass agentic fallback.

Each retry emits `logStructured("jules_cap_retry", { retry, of: 4, waitMinutes, status })`, using the shared retry number and HTTP status `400` or `429`.

### The retry uses a fresh session with the full budget

On timeout the action creates a fresh session with the same prompt and source and polls with the full `timeoutMinutes` budget (not halved). If both attempts time out, the logged error includes both session IDs and the result has `reviewResult: null`. Set workflow job `timeout-minutes` comfortably above `30 + 2 × timeout_minutes`; a shorter job timeout can kill the process before cleanup and leave its check run `in_progress`. At default settings, recommend `timeout-minutes: 150` for prompt mode, with further headroom for agentic fallback or extended SDK/readiness waits.

### Structured logging on retry

A retry emits a `core.info` line plus a structured log event carrying `{ failedSessionId, attempt }`. No retry-related events are emitted when the first attempt succeeds.

## Testing Decisions

- **What makes a good test:** Test the retry decision — one retry on timeout, no retry on success/auth/parse/readiness failures, the full-budget second attempt, the both-timeout error message containing both session IDs — without exercising the real Jules API.
- **Modules under test:**
  - `session.ts` — fake-timer tests for newest-review selection, two terminal polls, counter reset on active/error states, deadline-only timeout behavior, shared cap exhaustion across all session creation paths, original error causes and per-retry structured logs for both HTTP statuses.
  - `errors.ts` — raw precondition errors remain unknown; typed exhausted creation caps are quota failures.
  - `jules.ts` — `runJulesReview` retry behavior against a mocked `runSession` from `session.ts`; session-level tests also exercise the real orchestration for progress-only timeout retry and agentic fallback.
- **Prior art:** `tests/jules.test.ts` already mocks `runSession` and asserts review outcomes and error messages; the retry cases extend the same mock boundary (`vi.fn()` on `runSession`) and add assertions for the retry-emitted log events.

## Out of Scope

- Configurable retry counts (one fresh-session retry and four shared creation-cap retries).
- Retries on parse errors, auth errors (401/403), or readiness 404 loops.
- PR-size gates or automatic timeout adjustment.
- Additional retry policies beyond the creation-cap and timeout budgets described here.
- Retry logic in any other part of the codebase (e.g. GitHub API calls, submission).

## Further Notes

- The resilience module (`src/resilience.ts`) already provides `withRetry`/`withFallback` primitives for transient and permanent API failures; the timeout-retry lives in the review pipeline where the timeout signal originates.
- See ADR-009 for the architectural decision record of this capability.
