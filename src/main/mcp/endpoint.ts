import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

// Where the running app listens for `gitdesk --mcp`, and the secret that lets one in. Both are
// derived from the profile folder, so the app and the stdio process agree without any setting.

// A Unix socket path holds about 104 bytes; a long profile path falls back to the temp folder.
const SOCKET_PATH_MAX = 100;

const tag = (userData: string) =>
  createHash('sha256').update(userData).digest('hex').slice(0, 16);

// A long profile path falls back to the per-user runtime folder (XDG_RUNTIME_DIR, private to
// this user), else to a 0700 folder of this user's own under the temp folder, never straight
// into the shared temp folder where another user could take the name first.
export function mcpSocketPath(
  userData: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform === 'win32') return `\\\\.\\pipe\\gitdesk-mcp-${tag(userData)}`;
  const inProfile = path.join(userData, 'mcp.sock');
  if (inProfile.length <= SOCKET_PATH_MAX) return inProfile;
  const name = `gitdesk-mcp-${tag(userData)}.sock`;
  const runtime = env.XDG_RUNTIME_DIR;
  if (runtime && path.isAbsolute(runtime)) {
    const inRuntime = path.join(runtime, name);
    if (inRuntime.length <= SOCKET_PATH_MAX) return inRuntime;
  }
  return path.join(privateTempDir(), name);
}

// <tmp>/gitdesk-<uid>: the folder, not the socket name, is what has to be this user's.
export const privateTempDir = () =>
  path.join(os.tmpdir(), `gitdesk-${os.userInfo().uid}`);

// Readable by this user only (0600). A new one is written every time the app starts listening,
// so a stdio process left over from an earlier run can't reconnect.
export const mcpTokenPath = (userData: string) =>
  path.join(userData, 'mcp.token');

// The first line a stdio process sends; everything after it is the MCP stream.
export type Hello = { gitdesk: 1; token: string };
export const HELLO_MAX = 512;
