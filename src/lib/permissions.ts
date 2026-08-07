import { withChromeCallbackDeadline } from './chromeCallback';

export const PERMISSION_REQUEST_CALLBACK_DEADLINE_MS = 15_000;

export type OriginPermissionResult =
  | { ok: true; origin: string }
  | { ok: false; error: { code: 'validation' | 'permission-denied'; message: string } };

export type OriginPermissionOperationResult<T> = { ok: true; value: T } | Extract<OriginPermissionResult, { ok: false }>;
export type OriginsPermissionResult = { ok: true; origins: string[] } | Extract<OriginPermissionResult, { ok: false }>;
type PermissionRequestResult = 'granted' | 'denied' | 'failed';

/** Request the one host permission needed after a user-initiated action. */
export async function requestOriginPermission(input: string): Promise<OriginPermissionResult> {
  const origin = exactHttpsOrigin(input);
  if (!origin) return { ok: false, error: { code: 'validation', message: 'A permission can only be requested for an HTTPS URL without user information.' } };
  const request = await requestPermissions([origin]);
  const granted = request === 'granted' || await containsPermissions([origin]);
  return granted ? { ok: true, origin } : denied();
}

export async function hasOriginPermission(input: string): Promise<boolean> {
  const origin = exactHttpsOrigin(input);
  return Boolean(origin && await containsPermissions([origin]));
}

/** Invoke this from a user click handler to ensure no host operation starts before consent. */
export async function runWithOriginPermission<T>(input: string, operation: () => Promise<T>): Promise<OriginPermissionOperationResult<T>> {
  const permission = await requestOriginPermission(input);
  if (!permission.ok) return permission;
  return { ok: true, value: await operation() };
}

/** Batch all exact origins into the one permission request allowed by the initiating click. */
export async function runWithOriginPermissions<T>(inputs: readonly string[], operation: () => Promise<T>): Promise<OriginPermissionOperationResult<T>> {
  const permission = await requestOriginPermissions(inputs);
  if (!permission.ok) return permission;
  return { ok: true, value: await operation() };
}

export async function requestOriginPermissions(inputs: readonly string[]): Promise<OriginsPermissionResult> {
  const origins: string[] = [];
  const seen = new Set<string>();
  for (const input of inputs) {
    const origin = exactHttpsOrigin(input);
    if (!origin) return { ok: false, error: { code: 'validation', message: 'Permissions require HTTPS URLs without user information.' } };
    if (!seen.has(origin)) { seen.add(origin); origins.push(origin); }
  }
  if (!origins.length) return { ok: false, error: { code: 'validation', message: 'At least one HTTPS origin is required.' } };
  const request = await requestPermissions(origins);
  return request === 'granted' || await containsPermissions(origins) ? { ok: true, origins } : denied();
}

function requestPermissions(origins: string[]): Promise<PermissionRequestResult> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const complete = (value: PermissionRequestResult) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(value);
    };
    timer = setTimeout(() => complete('denied'), PERMISSION_REQUEST_CALLBACK_DEADLINE_MS);
    try {
      chrome.permissions.request({ origins }, (granted) => {
        complete(chrome.runtime?.lastError ? 'failed' : granted ? 'granted' : 'denied');
      });
    } catch {
      complete('failed');
    }
  });
}

function containsPermissions(origins: string[]): Promise<boolean> {
  return withChromeCallbackDeadline((complete) => {
    chrome.permissions.contains({ origins }, (contains) => {
      const failed = Boolean(chrome.runtime?.lastError);
      complete(Boolean(contains) && !failed);
    });
  }, false);
}

function exactHttpsOrigin(input: string): string | undefined {
  try {
    const url = new URL(input);
    return url.protocol === 'https:' && !url.username && !url.password ? `${url.origin}/*` : undefined;
  } catch { return undefined; }
}

function denied(): Extract<OriginPermissionResult, { ok: false }> { return { ok: false, error: { code: 'permission-denied', message: '未获得目标域名访问权限，请在浏览器权限窗口中允许后重试。' } }; }
