import { useEffect, useState } from 'react';

// Chromium's Network Information API: estimates from recent traffic, rounded by the browser
// (25 ms, 25 kbps). Good enough to label a connection, never shown as a measurement.
type Connection = EventTarget & {
  rtt?: number;
  downlink?: number;
};

export type ConnectionQuality = {
  level: 0 | 1 | 2 | 3 | 4;
  label: 'Offline' | 'Weak' | 'Fair' | 'Good' | 'Excellent';
  rtt: number | null;
  downlink: number | null;
};

export function qualityOf(
  online: boolean,
  rtt: number | null,
  downlink: number | null,
): ConnectionQuality {
  const base = { rtt, downlink };
  if (!online) return { ...base, level: 0, label: 'Offline' };
  const r = rtt ?? 0;
  const d = downlink ?? Infinity;
  if (r < 100 && d >= 10) return { ...base, level: 4, label: 'Excellent' };
  if (r < 300 && d >= 2) return { ...base, level: 3, label: 'Good' };
  if (r < 1000 && d >= 0.5) return { ...base, level: 2, label: 'Fair' };
  return { ...base, level: 1, label: 'Weak' };
}

const read = (): ConnectionQuality => {
  const connection = (navigator as Navigator & { connection?: Connection })
    .connection;
  return qualityOf(
    navigator.onLine,
    typeof connection?.rtt === 'number' ? connection.rtt : null,
    typeof connection?.downlink === 'number' ? connection.downlink : null,
  );
};

// Follows online/offline and the browser's connection estimate as they change.
export function useConnection(): ConnectionQuality {
  const [quality, setQuality] = useState(read);
  useEffect(() => {
    const update = () => setQuality(read());
    const connection = (navigator as Navigator & { connection?: Connection })
      .connection;
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    connection?.addEventListener('change', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
      connection?.removeEventListener('change', update);
    };
  }, []);
  return quality;
}
