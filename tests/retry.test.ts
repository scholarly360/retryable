import { describe, it, expect, vi, beforeEach } from "vitest";
import { retry, withRetry, RetryError } from "../src/index";

beforeEach(() => {
  vi.useFakeTimers();
});

// ─── helpers ────────────────────────────────────────────────────────────────

function flaky(succeedOnAttempt: number) {
  let calls = 0;
  return async () => {
    calls++;
    if (calls < succeedOnAttempt) throw new Error(`attempt ${calls} failed`);
    return `ok on attempt ${calls}`;
  };
}

async function runWithTimers<T>(promise: Promise<T>): Promise<T> {
  const result = promise;
  await vi.runAllTimersAsync();
  return result;
}

// ─── retry ──────────────────────────────────────────────────────────────────

describe("retry()", () => {
  it("returns immediately on first success", async () => {
    const result = await retry(() => Promise.resolve("hello"));
    expect(result).toBe("hello");
  });

  it("retries and succeeds on a later attempt", async () => {
    const fn = flaky(3);
    const promise = retry(fn, { attempts: 3, delay: 10 });
    await vi.runAllTimersAsync();
    expect(await promise).toBe("ok on attempt 3");
  });

  it("throws RetryError after all attempts fail", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("boom"));
    const promise = retry(fn, { attempts: 3, delay: 10 }).catch((e) => e);
    await vi.runAllTimersAsync();
    const err = await promise;
    expect(err).toBeInstanceOf(RetryError);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("RetryError carries all errors and attempt count", async () => {
    const errs = [new Error("a"), new Error("b"), new Error("c")];
    let i = 0;
    const promise = retry(() => Promise.reject(errs[i++]), {
      attempts: 3,
      delay: 10,
    }).catch((e) => e);
    await vi.runAllTimersAsync();
    const caught = await promise;
    expect(caught).toBeInstanceOf(RetryError);
    expect(caught.errors).toEqual(errs);
    expect(caught.attempts).toBe(3);
  });

  it("respects retryIf and rethrows immediately when false", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("not retryable"));
    const promise = retry(fn, {
      attempts: 5,
      delay: 10,
      retryIf: () => false,
    }).catch((e) => e);
    await vi.runAllTimersAsync();
    const err = await promise;
    expect(err).toBeInstanceOf(RetryError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("calls onRetry with error, attempt number, and delay", async () => {
    const onRetry = vi.fn();
    const fn = flaky(3);
    const promise = retry(fn, { attempts: 3, delay: 100, jitter: false, backoff: "fixed", onRetry });
    await vi.runAllTimersAsync();
    await promise;
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls[0][1]).toBe(1);
    expect(onRetry.mock.calls[0][2]).toBe(100);
    expect(onRetry.mock.calls[1][1]).toBe(2);
  });

  it("rejects with RetryError for attempts < 1", async () => {
    await expect(retry(() => Promise.resolve(), { attempts: 0 })).rejects.toThrow(RangeError);
  });

  it("single attempt does not retry", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("x"));
    const promise = retry(fn, { attempts: 1 }).catch((e) => e);
    await vi.runAllTimersAsync();
    const err = await promise;
    expect(err).toBeInstanceOf(RetryError);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

// ─── backoff strategies ──────────────────────────────────────────────────────

describe("backoff delays (no jitter)", () => {
  it("fixed: delay is always the base", async () => {
    const onRetry = vi.fn();
    const fn = vi.fn().mockRejectedValue(new Error());
    const promise = retry(fn, {
      attempts: 4,
      delay: 200,
      backoff: "fixed",
      jitter: false,
      onRetry,
    }).catch(() => {});
    await vi.runAllTimersAsync();
    await promise;
    const delays = onRetry.mock.calls.map((c) => c[2]);
    expect(delays).toEqual([200, 200, 200]);
  });

  it("linear: delay grows proportionally", async () => {
    const onRetry = vi.fn();
    const fn = vi.fn().mockRejectedValue(new Error());
    const promise = retry(fn, {
      attempts: 4,
      delay: 100,
      backoff: "linear",
      jitter: false,
      onRetry,
    }).catch(() => {});
    await vi.runAllTimersAsync();
    await promise;
    const delays = onRetry.mock.calls.map((c) => c[2]);
    expect(delays).toEqual([100, 200, 300]);
  });

  it("exponential: delay doubles", async () => {
    const onRetry = vi.fn();
    const fn = vi.fn().mockRejectedValue(new Error());
    const promise = retry(fn, {
      attempts: 4,
      delay: 100,
      backoff: "exponential",
      jitter: false,
      onRetry,
    }).catch(() => {});
    await vi.runAllTimersAsync();
    await promise;
    const delays = onRetry.mock.calls.map((c) => c[2]);
    expect(delays).toEqual([100, 200, 400]);
  });

  it("respects maxDelay cap", async () => {
    const onRetry = vi.fn();
    const fn = vi.fn().mockRejectedValue(new Error());
    const promise = retry(fn, {
      attempts: 4,
      delay: 1000,
      backoff: "exponential",
      jitter: false,
      maxDelay: 1500,
      onRetry,
    }).catch(() => {});
    await vi.runAllTimersAsync();
    await promise;
    const delays = onRetry.mock.calls.map((c) => c[2]);
    expect(Math.max(...delays)).toBeLessThanOrEqual(1500);
  });
});

// ─── withRetry ───────────────────────────────────────────────────────────────

describe("withRetry()", () => {
  it("wraps a function and passes arguments through", async () => {
    const inner = vi.fn(async (x: number) => x * 2);
    const wrapped = withRetry(inner, { attempts: 3 });
    const result = await wrapped(5);
    expect(result).toBe(10);
    expect(inner).toHaveBeenCalledWith(5);
  });

  it("retries the wrapped function on failure", async () => {
    let calls = 0;
    const inner = async (x: number) => {
      if (++calls < 3) throw new Error("fail");
      return x + 1;
    };
    const wrapped = withRetry(inner, { attempts: 3, delay: 10 });
    const promise = wrapped(9);
    await vi.runAllTimersAsync();
    expect(await promise).toBe(10);
  });
});
