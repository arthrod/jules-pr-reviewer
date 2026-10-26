# ADR-009: Jules polling and retry resilience

## Status
Accepted

## Date
2026-07-26

## Context
A session can produce progress messages, a review, and a trailing conversational note. The latest message alone is therefore not a reliable final answer, and progress alone must not suppress timeout recovery. Sessions here are fresh, without follow-up messages. `timeoutMinutes` bounds each session's review polling, not session creation retries.

Jules is an external service subject to transient outages, resource contention, or internal retries. A single 30-minute window may be insufficient during degraded periods. Without retry logic, transient failures cause permanent review loss, forcing manual re-runs.

## Decision

### Polling contract

- On every poll, read `session.info().state` and hydrate/read the activity history. States use SDK spelling, including `completed`, `failed` and `inProgress`.
- Return immediately when the latest `agentMessaged` parses as a review, even before terminal state. An older review does not end polling while a newer progress message or note is present.
- Stop after two consecutive polls report either `completed` or `failed`, allowing history to catch up. Any other state, or an `info()` exception, resets the consecutive-terminal counter; state-read errors do not abort polling.
- At that terminal stop, scan all `agentMessaged` messages newest first and return the most recent parseable review. If none parses, return the latest message so the existing parse-failure path handles a finished non-review response.
- At the deadline, return the most recent parseable review if one exists; otherwise return `""`, even when progress/non-review messages exist. Retain a previously observed review through later history errors. A non-review message is never returned merely because the deadline expired.
- `""` still means timeout. It triggers the fresh-session prompt retry or agentic fallback, rather than a parse failure. A finished session with no message also has no answer and returns this signal.

### Fresh-session timeout retry

Add a single retry in `runJulesReview` inside `src/jules.ts`:
- When `pollForReview` returns `""` (timeout only — NOT auth errors, parse errors, or readiness failures), create a fresh Jules session with the same prompt and source
- The retry uses the full `timeoutMinutes` budget (not halved)
- If the retry also times out, fail with an error message listing both session IDs
- Emit a `core.info` line and a structured log event (`jules_retry`) with `{ failedSessionId, attempt }` when retrying
- Auth 401/403, parse errors and exhausted readiness 404 loops do not trigger a fresh-session timeout retry

The retry logic extracts session creation, readiness polling and review polling into a callable unit, attempted at most twice in prompt mode. Agentic timeout falls back to prompt mode through the existing orchestration.

### Shared creation-cap retry budget

- Session creation refusals `400 FAILED_PRECONDITION` (concurrency cap) and `429` use waits of 5, 5, 5 and 15 minutes, giving four retries at 5, 10, 15 and 30 minutes after the first refusal when continuously refused.
- The retry counter lives at module level in `session.ts`. One budget is shared by every creation call in the action process: agentic creation, prompt fallback and timeout retry. Successful creates do not replenish it. Total action-level retry sleeps are at most 30 minutes; a later refusal fails immediately when the budget is spent. An exported reset helper is used only by tests.
- The SDK already retries HTTP `429` and `5xx` internally for up to 5 minutes per request before throwing. Those SDK waits are additional to the action-level budget. `429` may represent quota or rate limits, not exclusively a daily cap or a transient limit.
- The concurrency-cap interpretation applies only to creation. After exhausting the budget, creation throws `QuotaExceededError` with the original error as `cause` and guidance to wait for active sessions or reduce concurrency. `wrapJulesError` and `classifyFailure` do not infer a concurrency cap from raw `400 FAILED_PRECONDITION` during `info()` or `hydrate()`; classification uses the typed creation error.
- Each creation retry calls `logStructured("jules_cap_retry", { retry, of: 4, waitMinutes, status })`, where `status` is `400` or `429`. The warning and event use the shared retry number.

## Alternatives Considered

### Reuse same session
- Pros: No extra API call, simpler implementation
- Cons: If session is stuck internally, more polling won't help; session state may be corrupted
- Rejected: Fresh session gives Jules a clean slate

### Configurable retry count
- Pros: Teams can tune resilience vs. cost
- Cons: Adds complexity to action.yml and index.ts; if 2 sessions fail, a 3rd won't help
- Rejected: Single retry captures most transient failures without configuration burden

### Extend polling first then fresh session
- Pros: Maximizes single-session patience
- Cons: 30 min of polling already exhausted; extending further delays retry
- Rejected: User's timeout is per-attempt patience; retry should be immediate

### Split timeout budget (e.g., 15 min × 2 attempts)
- Pros: Same total latency, two chances
- Cons: Each attempt has reduced patience; transient 20-min outage fails both
- Rejected: User's timeout is per-attempt patience; splitting reduces effectiveness

### Retry on all errors
- Pros: Uniform error handling
- Cons: Auth/parse errors are deterministic; retrying wastes time and API calls
- Rejected: Fresh-session recovery is reserved for timeout; creation caps use the separate bounded schedule above

## Consequences
- **Positive:** Doubles effective timeout, handles transient Jules outages
- **Positive:** No new inputs, no action.yml changes, no index.ts changes
- **Positive:** Structured logging enables monitoring of retry frequency
- **Negative:** Prompt mode may poll twice (60 min at default 30-min timeout), plus up to 30 minutes of shared creation-cap sleeps and SDK/readiness waits. Agentic fallback can add another polling session. A job timeout shorter than `30 + 2 × timeout_minutes` can kill cleanup and leave an `in_progress` check; recommend `timeout-minutes: 150` at defaults for prompt mode, with further headroom for agentic fallback or extended SDK/readiness waits.
- **Negative:** Extra Jules API invocation on retry (cost implication)
- **Implementation:** `runJulesReview` in `src/jules.ts` refactored to extract retryable unit
- **Testing:** `tests/session.test.ts` covers latest-review completion, terminal history lag, trailing notes, deadline timeout recovery, shared mixed-status cap budgets and structured retry events. `tests/errors.test.ts` distinguishes typed creation caps from raw precondition errors; `tests/jules.test.ts` covers timeout retry decisions. All API calls and waits are replaced by local fixtures and fake timers.
- **Documentation:** This ADR recorded in `docs/adr/`
