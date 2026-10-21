const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
];

export function relativeTime(ms: number, now = Date.now()): string {
  const diff = ms - now;
  for (const [unit, size] of UNITS) {
    if (Math.abs(diff) >= size)
      return relative.format(Math.round(diff / size), unit);
  }
  return 'just now';
}

export const formatDate = (ms: number): string =>
  new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(ms);

export const PLATFORM_NAMES = {
  win32: 'Windows',
  darwin: 'macOS',
  linux: 'Linux',
} as const;
