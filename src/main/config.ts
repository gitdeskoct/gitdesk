export const APP_ORIGIN = 'app://gitdesk';

// Plain http is accepted only for a local Worker in unpackaged dev builds.
export function resolveApiOrigin(
  raw: string | undefined,
  packaged: boolean,
): string {
  const url = new URL(raw || 'http://localhost:8787');
  const local =
    url.protocol === 'http:' &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  if (url.protocol !== 'https:' && !(local && !packaged)) {
    throw new Error(`VITE_API_ORIGIN must be an https URL, got ${url.origin}`);
  }
  return url.origin;
}

export function allowedRendererOrigins(
  devServerUrl: string | undefined,
): string[] {
  return devServerUrl
    ? [APP_ORIGIN, new URL(devServerUrl).origin]
    : [APP_ORIGIN];
}

// Not URL.origin: Node treats app: as a non-special scheme and reports its origin as "null".
const originOf = (url: URL) => `${url.protocol}//${url.host}`;

export function isAllowedRendererUrl(url: string, origins: string[]): boolean {
  try {
    return origins.includes(originOf(new URL(url)));
  } catch {
    return false;
  }
}

// Every permission is refused except plain-text clipboard writes from gitdesk's own pages, which
// the copy buttons need. Reading the clipboard stays refused.
export function isAllowedPermission(
  permission: string,
  url: string,
  origins: string[],
): boolean {
  return (
    permission === 'clipboard-sanitized-write' &&
    isAllowedRendererUrl(url, origins)
  );
}
