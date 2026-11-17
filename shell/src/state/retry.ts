/**
 * The failure ladder: context overflow first, then account limits, then a whole-turn timeout, then
 * retryability (transport failures only — a connection that failed, not a server that answered), then
 * a bounded retry with exponential backoff.
 *
 * The timeout rung is the one deviation from Pi's order (#240). `timeoutMs` is a whole-turn cap
 * covering connect, prefill and every streamed token, so a timeout is not a transient connection
 * failure; retrying it multiplied one silent wait into up to ~8 minutes before `run_error`.
 *
 * The pattern tables are ported from the pinned `@earendil-works/pi-ai@1.5.0`:
 * `dist/utils/retry.js` (`isRetryableAssistantError`, `retryDelayMs`) and `dist/utils/overflow.js`
 * (`isContextOverflow`). They are ported rather than imported because pi-ai is a devDependency of the
 * spike and the adapter layer must stay removable; the pin test still guards the version they came
 * from.
 */

export interface RetryPolicy {
  enabled: boolean;
  /** Additional attempts after the first call. Pi's `maxRetries`. */
  maxRetries: number;
  baseDelayMs: number;
  /** One delay's ceiling; Pi's `DEFAULT_MAX_AGENT_RETRY_DELAY_MS`. */
  maxDelayMs: number;
}

export const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  enabled: true,
  maxRetries: 3,
  baseDelayMs: 1_000,
  maxDelayMs: DEFAULT_MAX_RETRY_DELAY_MS,
};

/** What a failed provider call is, decided before anything is retried. */
export type FailureKind = 'overflow' | 'timeout' | 'retryable' | 'fatal';

/**
 * The named class of an endpoint failure, for diagnosis only — the ladder above still decides what
 * happens. A custom OpenAI-compatible endpoint fails in a handful of distinguishable ways, and "查钥"
 * and "查模型名" are the two hints a user cannot guess from `fatal` alone.
 */
export type EndpointFailureKind = 'timeout' | 'unreachable' | 'auth' | 'model_not_found' | 'rate_limit' | 'http' | 'unknown';

/**
 * Order matters: a transport failure carries no status, and a timeout's text can also look like a
 * connection error, so the transport shapes are read before the HTTP status.
 */
export function classifyEndpointFailure(message: string): EndpointFailureKind {
  if (/abort|timeout|timed? ?out/i.test(message)) return 'timeout';
  if (/fetch failed|unable to connect|connection (refused|reset|closed)|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(message)) return 'unreachable';
  const status = /(?<![a-z0-9])(\d{3})(?![a-z0-9])/i.exec(message)?.[1];
  switch (status) {
    case '401':
    case '403':
      return 'auth';
    case '404':
      return 'model_not_found';
    case '429':
      return 'rate_limit';
    case undefined:
      return 'unknown';
    default:
      return 'http';
  }
}

export type FailurePlan =
  | { action: 'retry'; attempt: number; delayMs: number; kind: 'retryable' }
  | { action: 'recover_overflow'; attempt: number; delayMs: number; kind: 'overflow' }
  | { action: 'fail'; kind: FailureKind; reason: string };

/** Input exceeded the model's context window or the provider's request-size limit. */
const OVERFLOW_PATTERNS = [
  /prompt (?:is )?too long/i,
  /request_too_large/i,
  /exceeds the context window/i,
  /exceeds (?:the )?(?:model'?s )?maximum context length/i,
  /context window exceeded/i,
  /context[_ ]length[_ ]exceeded/i,
  /maximum context length is \d+ tokens/i,
  /too many tokens/i,
  /token limit exceeded/i,
  /reduce the length of the messages/i,
  /^(?:[\w -]+ API error \(413\):|413(?:\s|:|$))/i,
];

/** A message can match an overflow pattern and still be a transient error; these win. */
const NON_OVERFLOW_PATTERNS = [/rate limit/i, /too many requests/i, /^(Throttling error|Service unavailable):/i];

/**
 * Account/subscription limits. They reset in hours, not seconds, so retrying only burns the day.
 * Pi's comment: these are checked before the retryable table precisely because some of them also
 * look transient.
 */
const NON_RETRYABLE_LIMIT_PATTERNS = [
  /GoUsageLimitError/i,
  /FreeUsageLimitError/i,
  /Monthly usage limit reached/i,
  /available balance/i,
  /insufficient_quota/i,
  /out of budget/i,
  /quota exceeded/i,
  /billing/i,
  /subscription_sharing_usage_limit_exceeded/i,
  /subscription_sharing_workplace_individual_usage_limit_exceeded/i,
  /"code"\s*:\s*"?1308(?![0-9])/i,
];

/**
 * The whole-turn cap firing. Bun's `AbortSignal.timeout` throws `TimeoutError: The operation timed
 * out.`; other runtimes say "aborted due to timeout". It is deliberately not in the table below: a
 * retry re-arms the same cap, so one slow turn becomes minutes of silence (#240).
 */
const TIMEOUT_PATTERNS = [/\bTimeoutError\b/i, /timed? ?out/i, /\btimeout\b/i];

/**
 * Transport failures only (#240). Server-capacity and rate-limit answers are not here: the provider
 * itself retries 429/5xx with its own budget (#282), and a second 1/2/4 s ladder retry would only
 * double the wait. `unable to forward upstream` / `upstream request failed` are the gateway's own
 * transport hop to the model, so they stay.
 */
const CONNECTION_FAILURE_PATTERNS = [
  /unable to forward upstream/i,
  /upstream.?request.?failed/i,
  /upstream_stream_read_error/i,
  /stream was interrupted/i,
  /http\/?2 stream failed/i,
  /network.?error/i,
  /connection.?error/i,
  /connection.?refused/i,
  /connection.?lost/i,
  // Bun's fetch says this for a refused connection; Pi's ported table predates it, and a user's own
  // OpenAI-compatible endpoint being down is exactly the transient case this rung exists for.
  /unable to connect/i,
  /other side closed/i,
  /fetch failed/i,
  /request to \S+ failed, reason:/i,
  /getaddrinfo/i,
  /ENOTFOUND/i,
  /EAI_AGAIN/i,
  /ECONNREFUSED|ECONNRESET|EPIPE|EHOSTUNREACH|ENETUNREACH/i,
  /upstream.?connect/i,
  /reset before headers/i,
  /socket hang up/i,
  /socket connection was closed/i,
  /terminated/i,
  /websocket.?closed/i,
  /websocket.?error/i,
  /ended without/i,
  /stream ended before message_stop/i,
  /http2 request did not get a response/i,
  /stream disconnected before completion/i,
  /pending stream has been canceled/i,
];

/** Overflow first, then account limits (non-retryable), then timeout, then the connection table. */
export function classifyProviderError(message: string): FailureKind {
  if (!message) return 'fatal';
  if (!NON_OVERFLOW_PATTERNS.some((pattern) => pattern.test(message)) && OVERFLOW_PATTERNS.some((pattern) => pattern.test(message))) {
    return 'overflow';
  }
  if (NON_RETRYABLE_LIMIT_PATTERNS.some((pattern) => pattern.test(message))) return 'fatal';
  if (TIMEOUT_PATTERNS.some((pattern) => pattern.test(message))) return 'timeout';
  if (CONNECTION_FAILURE_PATTERNS.some((pattern) => pattern.test(message))) return 'retryable';
  return 'fatal';
}

/**
 * The whole ladder in one pure decision: which of the three rungs this failure lands on, and what
 * the caller does next. `overflowRecoveryUsed` is the run's one-shot latch — an overflow gets its
 * recovery attempt once, and a second overflow in the same run is a failure, not a loop.
 */
export function planFailure(input: { message: string; attempt: number; policy: RetryPolicy; overflowRecoveryUsed: boolean }): FailurePlan {
  const kind = classifyProviderError(input.message);
  if (kind === 'overflow') {
    if (input.overflowRecoveryUsed) return { action: 'fail', kind: 'overflow', reason: `overflow_recovery_exhausted: ${input.message}` };
    return { action: 'recover_overflow', attempt: input.attempt, delayMs: 0, kind: 'overflow' };
  }
  if (kind === 'timeout') return { action: 'fail', kind: 'timeout', reason: `model_timeout: ${input.message}` };
  if (kind === 'retryable' && input.policy.enabled && input.attempt < input.policy.maxRetries) {
    const attempt = input.attempt + 1;
    return { action: 'retry', attempt, delayMs: retryDelayMs(input.policy, attempt), kind: 'retryable' };
  }
  return { action: 'fail', kind, reason: input.message };
}

/** `baseDelayMs × 2^(attempt-1)`, clamped to `maxDelayMs` (Pi's `retryDelayMs`). */
export function retryDelayMs(policy: RetryPolicy, attempt: number): number {
  const delay = policy.baseDelayMs * 2 ** Math.max(0, attempt - 1);
  const safe = Number.isSafeInteger(delay) ? delay : Number.MAX_SAFE_INTEGER;
  return Math.min(safe, policy.maxDelayMs);
}

/** Abortable sleep; an abort during backoff must end the run, not finish the wait (Pi's `sleep`). */
export function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      },
      { once: true },
    );
  });
}
