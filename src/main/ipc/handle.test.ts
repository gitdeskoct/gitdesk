import type { IpcMainInvokeEvent, WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { isTrustedSender } from './handle';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));

type Event = Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>;

const origins = ['app://gitdesk', 'http://localhost:5173'];
const contents = { id: 1 } as unknown as WebContents;
const other = { id: 2 } as unknown as WebContents;

function event(
  sender: WebContents,
  frame: { url: string; parent: unknown } | null = {
    url: 'http://localhost:5173/',
    parent: null,
  },
): Event {
  return { sender, senderFrame: frame } as unknown as Event;
}

describe('isTrustedSender', () => {
  it('accepts the main frame of the expected webContents on an allowed origin', () => {
    expect(isTrustedSender(event(contents), contents, origins)).toBe(true);
  });

  // Regression: Node reports app:// origins as "null", which once rejected the packaged renderer.
  it('accepts the packaged app:// renderer', () => {
    const frame = { url: 'app://gitdesk/index.html', parent: null };
    expect(isTrustedSender(event(contents, frame), contents, origins)).toBe(
      true,
    );
  });

  it('rejects when there is no expected webContents', () => {
    expect(isTrustedSender(event(contents), null, origins)).toBe(false);
  });

  it('rejects another webContents', () => {
    expect(isTrustedSender(event(other), contents, origins)).toBe(false);
  });

  it('rejects a subframe', () => {
    const frame = {
      url: 'app://gitdesk/index.html',
      parent: { url: 'app://gitdesk/' },
    };
    expect(isTrustedSender(event(contents, frame), contents, origins)).toBe(
      false,
    );
  });

  it('rejects a foreign origin', () => {
    const frame = { url: 'https://evil.example/', parent: null };
    expect(isTrustedSender(event(contents, frame), contents, origins)).toBe(
      false,
    );
  });

  it('rejects a missing sender frame', () => {
    expect(isTrustedSender(event(contents, null), contents, origins)).toBe(
      false,
    );
  });
});
