export type BackoffStrategy = "fixed" | "linear" | "exponential";

export interface RetryOptions<E = unknown> {
  /** Maximum number of attempts (including the first call). Default: 3 */
  attempts?: number;
  /** Base delay in milliseconds between retries. Default: 300 */
  delay?: number;
  /** How the delay grows across retries. Default: "exponential" */
  backoff?: BackoffStrategy;
  /** Add random ±25% jitter to each delay to avoid thundering herd. Default: true */
  jitter?: boolean;
  /** Cap the computed delay at this many ms. Default: 30_000 */
  maxDelay?: number;
  /** Return true to retry on this error, false to rethrow immediately. Default: always retry */
  retryIf?: (error: E, attempt: number) => boolean | Promise<boolean>;
  /** Called before each retry with the error that triggered it. */
  onRetry?: (error: E, attempt: number, delayMs: number) => void;
}

export class RetryError<E = unknown> extends Error {
  /** Every error thrown across all attempts, in order. */
  readonly errors: E[];
  /** Total number of attempts made. */
  readonly attempts: number;

  constructor(errors: E[], attempts: number) {
    const last = errors[errors.length - 1];
    const message =
      last instanceof Error
        ? `All ${attempts} attempt(s) failed. Last error: ${last.message}`
        : `All ${attempts} attempt(s) failed.`;
    super(message);
    this.name = "RetryError";
    this.errors = errors;
    this.attempts = attempts;
  }
}

function computeDelay(
  attempt: number,
  base: number,
  strategy: BackoffStrategy,
  jitter: boolean,
  maxDelay: number
): number {
  let delay: number;

  switch (strategy) {
    case "fixed":
      delay = base;
      break;
    case "linear":
      delay = base * attempt;
      break;
    case "exponential":
      delay = base * Math.pow(2, attempt - 1);
      break;
  }

  if (jitter) {
    const spread = delay * 0.25;
    delay = delay - spread + Math.random() * spread * 2;
  }

  return Math.min(Math.round(delay), maxDelay);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry an async function with configurable backoff, jitter, and error filtering.
 *
 * @example
 * const data = await retry(() => fetch("/api/data").then(r => r.json()), {
 *   attempts: 4,
 *   backoff: "exponential",
 *   jitter: true,
 *   retryIf: (err) => err instanceof NetworkError,
 * });
 */
export async function retry<T, E = unknown>(
  fn: () => Promise<T>,
  options: RetryOptions<E> = {}
): Promise<T> {
  const {
    attempts = 3,
    delay = 300,
    backoff = "exponential",
    jitter = true,
    maxDelay = 30_000,
    retryIf,
    onRetry,
  } = options;

  if (attempts < 1) throw new RangeError("`attempts` must be at least 1");

  const errors: E[] = [];

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const typedErr = err as E;
      errors.push(typedErr);

      const isLastAttempt = attempt === attempts;
      if (isLastAttempt) break;

      const shouldRetry = retryIf
        ? await retryIf(typedErr, attempt)
        : true;

      if (!shouldRetry) break;

      const delayMs = computeDelay(attempt, delay, backoff, jitter, maxDelay);
      onRetry?.(typedErr, attempt, delayMs);
      await sleep(delayMs);
    }
  }

  throw new RetryError(errors, errors.length);
}

/**
 * Wrap a function so every call is automatically retried.
 * Useful for wrapping fetch, db clients, or any flaky IO.
 *
 * @example
 * const fetchWithRetry = withRetry(fetch, { attempts: 3 });
 * const res = await fetchWithRetry("/api/data");
 */
export function withRetry<T extends (...args: never[]) => Promise<unknown>>(
  fn: T,
  options: RetryOptions = {}
): T {
  return ((...args: Parameters<T>) =>
    retry(() => fn(...args), options)) as T;
}
