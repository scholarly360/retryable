# retryable

Retry any async function with typed backoff, jitter, and error filtering. Zero dependencies. ~1.9 KB ESM.

```ts
import { retry } from "retryable";

const data = await retry(() => fetch("/api/data").then(r => r.json()), {
  attempts: 4,
  backoff: "exponential",
  jitter: true,
});
```

## Install

```sh
npm install retryable
```

## API

### `retry(fn, options?)`

Calls `fn` and retries on failure according to `options`. Returns the resolved value of `fn` or throws a `RetryError` if all attempts fail.

```ts
retry<T, E = unknown>(
  fn: () => Promise<T>,
  options?: RetryOptions<E>
): Promise<T>
```

#### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `attempts` | `number` | `3` | Total attempts, including the first call |
| `delay` | `number` | `300` | Base delay in ms between retries |
| `backoff` | `"fixed" \| "linear" \| "exponential"` | `"exponential"` | How the delay grows |
| `jitter` | `boolean` | `true` | Add ±25% random spread to avoid thundering herd |
| `maxDelay` | `number` | `30_000` | Hard cap on computed delay in ms |
| `retryIf` | `(err: E, attempt: number) => boolean \| Promise<boolean>` | always retry | Return `false` to rethrow immediately without further attempts |
| `onRetry` | `(err: E, attempt: number, delayMs: number) => void` | — | Called before each retry sleep |

#### Backoff behaviour (base delay = 300ms, no jitter)

| Strategy | Retry 1 | Retry 2 | Retry 3 |
|----------|---------|---------|---------|
| `fixed` | 300ms | 300ms | 300ms |
| `linear` | 300ms | 600ms | 900ms |
| `exponential` | 300ms | 600ms | 1200ms |

---

### `withRetry(fn, options?)`

Wraps a function so every call is automatically retried. Useful for wrapping `fetch`, db clients, or any flaky IO at the module boundary.

```ts
withRetry<T extends (...args) => Promise<unknown>>(
  fn: T,
  options?: RetryOptions
): T
```

```ts
import { withRetry } from "retryable";

// Wrap once at module level
const robustFetch = withRetry(fetch, { attempts: 3 });

// Call normally everywhere else
const res = await robustFetch("/api/users");
```

---

### `RetryError`

Thrown when all attempts are exhausted. Extends `Error`.

```ts
class RetryError<E = unknown> extends Error {
  readonly errors: E[];    // every error thrown, in order
  readonly attempts: number;
}
```

```ts
import { retry, RetryError } from "retryable";

try {
  await retry(fetchData, { attempts: 3 });
} catch (err) {
  if (err instanceof RetryError) {
    console.log(`Failed after ${err.attempts} attempts`);
    console.log("First error:", err.errors[0]);
    console.log("Last error:", err.errors[err.errors.length - 1]);
  }
}
```

---

## Recipes

### Only retry on specific errors

```ts
import { retry } from "retryable";

class RateLimitError extends Error {}

await retry(callApi, {
  attempts: 5,
  delay: 1000,
  backoff: "exponential",
  retryIf: (err) => err instanceof RateLimitError,
});
```

### Log retries for observability

```ts
await retry(fetchData, {
  attempts: 4,
  onRetry: (err, attempt, delayMs) => {
    console.warn(`Attempt ${attempt} failed (${err.message}). Retrying in ${delayMs}ms…`);
  },
});
```

### Async `retryIf` — check a circuit breaker

```ts
await retry(fetchData, {
  retryIf: async (err, attempt) => {
    const open = await circuitBreaker.isOpen();
    return !open;
  },
});
```

### Wrap your entire db client

```ts
import { withRetry } from "retryable";
import { db } from "./db";

export const resilientDb = {
  query: withRetry(db.query.bind(db), {
    attempts: 3,
    delay: 200,
    retryIf: (err) => err.code === "ECONNRESET",
  }),
};
```

### One-shot — no retries, just the typed error

```ts
// attempts: 1 means exactly one call, no retries
const result = await retry(fn, { attempts: 1 });
```

---

## TypeScript

The `E` type parameter lets you type the error. If you pass `retryIf` or `onRetry`, TypeScript infers `E` from your callback:

```ts
// E is inferred as ApiError
await retry<User, ApiError>(fetchUser, {
  retryIf: (err) => err.status >= 500,  // err: ApiError ✓
  onRetry:  (err) => log(err.status),   // err: ApiError ✓
});
```

---

## License

MIT
