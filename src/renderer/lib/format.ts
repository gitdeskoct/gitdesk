import { useEffect, useState } from 'react';

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

// Re-renders once a minute so "3 minutes ago" and the date line don't go stale on an open page.
export function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
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
