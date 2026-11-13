import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { rmSync } from 'node:fs';
import { chmod, lstat, mkdir, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  serveStdio,
  StdioServerTransport,
} from '@modelcontextprotocol/server/stdio';
import {
  HELLO_MAX,
  mcpSocketPath,
  mcpTokenPath,
  privateTempDir,
  type Hello,
} from './endpoint';

// The temp-folder fallback must be a real folder this user owns that nobody else can enter;
// anything else (a link, someone else's folder) is refused rather than listened in.
async function ensurePrivateDir(dir: string) {
  await mkdir(dir, { mode: 0o700, recursive: true });
  const info = await lstat(dir);
  const uid = process.getuid?.();
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (uid !== undefined && info.uid !== uid) ||
    (info.mode & 0o077) !== 0
  )
    throw new Error(`${dir} is not a private folder of this user`);
}

// The app's side of `gitdesk --mcp`: a socket only this user can reach, one MCP session per
// connection. A connection that doesn't open with the current token is dropped before any MCP
// message is read.

const HELLO_TIMEOUT_MS = 5000;
// Agents on one computer are few; past this a new connection is turned away.
const MAX_CONNECTIONS = 16;

export type Connection = {
  id: string;
  client: () => string;
  // Aborted when the connection closes: whatever it was still waiting for is withdrawn.
  closed: AbortSignal;
};

// Control and format characters out (bidi overrides and zero-width characters can make one
// name look like another), whitespace collapsed.
export const cleanName = (value: unknown): string | null =>
  typeof value === 'string'
    ? value
        .replace(/[\p{Cc}\p{Cf}]/gu, '')
        .replace(/\s+/gu, ' ')
        .trim()
        .slice(0, 60) || null
    : null;

// Where a client says who it is: in `initialize` (protocol up to 2025), or, in the stateless
// protocol (2026-07-28 on), in every request's `_meta`, with no `initialize` at all. The display
// title wins over the machine name.
const CLIENT_INFO_META = 'io.modelcontextprotocol/clientInfo';
type ClientInfo = { name?: unknown; title?: unknown };
export function clientNameOf(message: unknown): string | null {
  if (!message || typeof message !== 'object') return null;
  const { method, params } = message as {
    method?: unknown;
    params?: { clientInfo?: ClientInfo; _meta?: Record<string, unknown> };
  };
  if (typeof method !== 'string' || !params || typeof params !== 'object')
    return null;
  const info =
    method === 'initialize'
      ? params.clientInfo
      : (params._meta?.[CLIENT_INFO_META] as ClientInfo | undefined);
  if (!info || typeof info !== 'object') return null;
  return cleanName(info.title) ?? cleanName(info.name);
}

export type LocalServer = {
  close(): Promise<void>;
  clients(): string[];
  // Synchronous, for quitting: no new agent can find or open the connection afterwards.
  removeFiles(): void;
};

export async function startLocalServer(deps: {
  userData: string;
  build: (connection: Connection) => McpServer;
  onChange: () => void;
  log: (message: string, error?: unknown) => void;
}): Promise<LocalServer> {
  const socketPath = mcpSocketPath(deps.userData);
  const tokenPath = mcpTokenPath(deps.userData);
  const token = randomBytes(32).toString('hex');
  const expected = Buffer.from(token);
  const open = new Map<
    net.Socket,
    { name: string | null; stop?: () => void }
  >();
  // Connections still on their hello count too, so a burst of silent ones can't pile up.
  let greeting = 0;

  if (
    process.platform !== 'win32' &&
    path.dirname(socketPath) === privateTempDir()
  )
    await ensurePrivateDir(privateTempDir());
  // A socket file left by a crash would make listen fail; a pipe on Windows has no file.
  if (process.platform !== 'win32') await rm(socketPath, { force: true });

  function accept(socket: net.Socket) {
    if (open.size + greeting >= MAX_CONNECTIONS) {
      socket.destroy();
      return;
    }
    greeting++;
    let greeted = false;
    const doneGreeting = () => {
      if (!greeted) {
        greeted = true;
        greeting--;
      }
    };
    const state: { name: string | null; stop?: () => void } = { name: null };
    const closed = new AbortController();
    let header = Buffer.alloc(0);
    const timer = setTimeout(() => socket.destroy(), HELLO_TIMEOUT_MS);
    socket.on('error', () => undefined);
    socket.once('close', () => {
      clearTimeout(timer);
      doneGreeting();
      closed.abort();
      state.stop?.();
      if (open.delete(socket)) deps.onChange();
    });

    const onHello = (chunk: Buffer) => {
      header = Buffer.concat([header, chunk]);
      const end = header.indexOf(0x0a);
      if (end < 0) {
        if (header.length > HELLO_MAX) socket.destroy();
        return;
      }
      socket.off('data', onHello);
      clearTimeout(timer);
      doneGreeting();
      let given = Buffer.alloc(0);
      try {
        const hello = JSON.parse(
          header.subarray(0, end).toString('utf8'),
        ) as Partial<Hello>;
        if (hello.gitdesk === 1 && typeof hello.token === 'string')
          given = Buffer.from(hello.token);
      } catch {
        // Not a hello: dropped below like a wrong token.
      }
      if (
        given.length !== expected.length ||
        !timingSafeEqual(given, expected)
      ) {
        socket.destroy();
        return;
      }
      open.set(socket, state);
      // The agent names itself in its first MCP message. The name labels approvals and the
      // activity list; it is a claim, and the page says so.
      let scanned = '';
      const sniff = (data: Buffer) => {
        scanned += data.toString('utf8');
        for (
          let nl = scanned.indexOf('\n');
          nl >= 0;
          nl = scanned.indexOf('\n')
        ) {
          const line = scanned.slice(0, nl);
          scanned = scanned.slice(nl + 1);
          try {
            const name = clientNameOf(JSON.parse(line));
            if (name) {
              state.name = name;
              socket.off('data', sniff);
              deps.onChange();
              return;
            }
          } catch {
            // The MCP transport reports malformed lines itself.
          }
        }
        if (scanned.length > 64 * 1024) socket.off('data', sniff);
      };
      socket.on('data', sniff);
      const id = randomUUID();
      const handle = serveStdio(
        () =>
          deps.build({
            id,
            client: () => state.name ?? 'An agent',
            closed: closed.signal,
          }),
        {
          transport: new StdioServerTransport(socket, socket),
          onerror: (error) => deps.log('MCP connection error', error),
        },
      );
      state.stop = () => void handle.close().catch(() => undefined);
      // Bytes that arrived in the same chunk as the hello belong to the MCP stream.
      const rest = header.subarray(end + 1);
      if (rest.length) socket.unshift(rest);
      deps.onChange();
    };
    socket.on('data', onHello);
  }

  const server = net.createServer(accept);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
  server.on('error', (error) => deps.log('MCP socket error', error));
  if (process.platform !== 'win32') await chmod(socketPath, 0o600);
  await writeFile(tokenPath, token, { mode: 0o600 });
  // writeFile's mode only applies to a new file.
  if (process.platform !== 'win32') await chmod(tokenPath, 0o600);

  return {
    clients: () => [...open.values()].map((state) => state.name ?? 'An agent'),
    removeFiles() {
      rmSync(tokenPath, { force: true });
      if (process.platform !== 'win32') rmSync(socketPath, { force: true });
    },
    async close() {
      // end() lets a reply already written reach the agent; destroy() is for one that won't leave.
      for (const socket of open.keys()) {
        socket.end();
        setTimeout(() => socket.destroy(), 500).unref();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(tokenPath, { force: true });
      if (process.platform !== 'win32') await rm(socketPath, { force: true });
    },
  };
}
