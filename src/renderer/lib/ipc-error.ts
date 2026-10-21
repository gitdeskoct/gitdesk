// Electron prefixes rejected invokes with "Error invoking remote method '<channel>': Error: ".
export const ipcErrorMessage = (err: unknown, fallback: string): string => {
  const raw = err instanceof Error ? err.message : '';
  const message = raw.replace(
    /^Error invoking remote method '[^']+': (?:\w*Error: )?/,
    '',
  );
  return message && message !== raw ? message : fallback;
};
