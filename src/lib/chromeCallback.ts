export const CHROME_CALLBACK_DEADLINE_MS = 5_000;

/** Bounds callback-only Chrome APIs so a missing callback cannot strand the UI. */
export function withChromeCallbackDeadline<T>(
  start: (complete: (value: T) => void) => void,
  fallback: T,
  timeoutMs = CHROME_CALLBACK_DEADLINE_MS
): Promise<T> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const complete = (value: T) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(value);
    };
    timer = setTimeout(() => complete(fallback), timeoutMs);
    try { start(complete); }
    catch { complete(fallback); }
  });
}
