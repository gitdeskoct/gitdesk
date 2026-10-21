import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';
import type { z } from 'zod';
import { isAllowedRendererUrl } from '../config';

export function isTrustedSender(
  event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>,
  expected: WebContents | null,
  origins: string[],
): boolean {
  const frame = event.senderFrame;
  return (
    !!expected &&
    event.sender === expected &&
    !!frame &&
    frame.parent === null &&
    isAllowedRendererUrl(frame.url, origins)
  );
}

export type Handle = <S extends z.ZodType, R>(
  channel: string,
  schema: S,
  fn: (input: z.infer<S>) => R | Promise<R>,
) => void;

// Every privileged handler goes through here: sender check first, then runtime input validation.
export function createHandle(
  getContents: () => WebContents | null,
  origins: string[],
): Handle {
  return (channel, schema, fn) => {
    ipcMain.handle(channel, async (event, raw: unknown) => {
      if (!isTrustedSender(event, getContents(), origins)) {
        throw new Error('Request rejected.');
      }
      const input = schema.safeParse(raw);
      if (!input.success) throw new Error('Invalid request.');
      return fn(input.data);
    });
  };
}
