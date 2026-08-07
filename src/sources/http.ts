export type HttpFailureKind = 'network' | 'timeout' | 'redirect' | 'too-large';

export class HttpRequestError extends Error {
  constructor(readonly kind: HttpFailureKind) { super(kind); }
}

export const MAX_JSON_BYTES = 5 * 1024 * 1024;

export type SourceFetch = (url: string, init?: RequestInit) => Promise<Response>;
export interface HttpRequestOptions {
  timeoutMs: number;
  controller?: AbortController;
  maxBytes?: number;
}

export async function cancelBody(response: Response): Promise<void> {
  try { await response.body?.cancel(); } catch { /* cancellation is best effort */ }
}

export async function fetchResponse(fetcher: SourceFetch, url: string, init: RequestInit, options: HttpRequestOptions): Promise<Response> {
  const controller = options.controller ?? new AbortController();
  return withinDeadline(async () => {
    let response: Response;
    try { response = await fetcher(url, { ...init, redirect: 'manual', signal: controller.signal }); }
    catch (error) { if (error instanceof HttpRequestError) throw error; throw new HttpRequestError(controller.signal.aborted ? 'timeout' : 'network'); }
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      await cancelBody(response);
      throw new HttpRequestError('redirect');
    }
    return response;
  }, { ...options, controller });
}

export async function fetchJson(fetcher: SourceFetch, url: string, init: RequestInit, options: HttpRequestOptions): Promise<{ response: Response; value: unknown }> {
  const controller = options.controller ?? new AbortController();
  let activeResponse: Response | undefined;
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  return withinDeadline(async () => {
    const response = await fetchResponse(fetcher, url, init, { ...options, controller, timeoutMs: 0 });
    activeResponse = response;
    if (!response.ok) { await cancelBody(response); return { response, value: undefined }; }
    const contentLength = Number(response.headers.get('Content-Length'));
    const maxBytes = options.maxBytes ?? MAX_JSON_BYTES;
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      await cancelBody(response);
      throw new HttpRequestError('too-large');
    }
    const text = await readText(response, maxBytes, (reader) => { activeReader = reader; });
    try { return { response, value: JSON.parse(text) }; }
    catch { throw new SyntaxError('Invalid JSON.'); }
  }, { ...options, controller }, () => activeReader ? activeReader.cancel() : activeResponse ? cancelBody(activeResponse) : undefined);
}

/** Fetch a successful response as bounded text, applying one deadline to fetch and body consumption. */
export async function fetchText(fetcher: SourceFetch, url: string, init: RequestInit, options: HttpRequestOptions): Promise<{ response: Response; text: string | undefined }> {
  const controller = options.controller ?? new AbortController();
  let activeResponse: Response | undefined;
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  return withinDeadline(async () => {
    const response = await fetchResponse(fetcher, url, init, { ...options, controller, timeoutMs: 0 });
    activeResponse = response;
    if (!response.ok) { await cancelBody(response); return { response, text: undefined }; }
    const contentLength = Number(response.headers.get('Content-Length'));
    const maxBytes = options.maxBytes ?? MAX_JSON_BYTES;
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      await cancelBody(response);
      throw new HttpRequestError('too-large');
    }
    return { response, text: await readText(response, maxBytes, (reader) => { activeReader = reader; }) };
  }, { ...options, controller }, () => activeReader ? activeReader.cancel() : activeResponse ? cancelBody(activeResponse) : undefined);
}

async function readText(response: Response, maxBytes: number, onReader?: (reader: ReadableStreamDefaultReader<Uint8Array>) => void): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  onReader?.(reader);
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) { await reader.cancel(); throw new HttpRequestError('too-large'); }
      text += decoder.decode(next.value, { stream: true });
    }
    return text + decoder.decode();
  } finally { reader.releaseLock(); }
}

function withinDeadline<T>(work: () => Promise<T>, options: HttpRequestOptions, onTimeout?: () => Promise<void> | void): Promise<T> {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) return work();
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      options.controller?.abort();
      try { void Promise.resolve(onTimeout?.()).catch(() => undefined); } catch { /* cancellation is best effort */ }
      reject(new HttpRequestError('timeout'));
    }, options.timeoutMs);
    work().then((value) => { clearTimeout(timeout); resolve(value); }, (error: unknown) => { clearTimeout(timeout); reject(error); });
  });
}
