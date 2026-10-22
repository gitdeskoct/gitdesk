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

// Sizes and speeds in the units people read on download screens: KB, MB, GB (base 1024).
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export const formatRate = (bytesPerSecond: number): string =>
  `${formatBytes(bytesPerSecond)}/s`;

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, ms / 1000);
  if (seconds < 10) return `${seconds.toFixed(1)} s`;
  if (seconds < 60) return `${Math.round(seconds)} s`;
  return `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`;
}

export const formatDate = (ms: number): string =>
  new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(ms);

export const PLATFORM_NAMES = {
  win32: 'Windows',
  darwin: 'macOS',
  linux: 'Linux',
} as const;
