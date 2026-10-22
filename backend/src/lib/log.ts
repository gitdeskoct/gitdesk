// The field list is the redaction policy: tokens, codes, verifiers and headers have no slot here.
type LogFields = {
  requestId?: string;
  accountId?: string;
  sessionId?: string;
  code?: string;
  path?: string;
  status?: number;
  error?: string;
  // Which kind of Git token was issued, never the token itself.
  scope?: 'read' | 'write';
  lifetime?: number;
};

export function logEvent(
  event: string,
  fields: LogFields = {},
  level: 'info' | 'warn' | 'error' = 'info',
): void {
  const line = JSON.stringify({ event, ...fields });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}
