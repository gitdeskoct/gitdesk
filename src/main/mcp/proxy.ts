import { readFile } from 'node:fs/promises';
import net from 'node:net';
import { mcpSocketPath, mcpTokenPath, type Hello } from './endpoint';

// `gitdesk --mcp`: what an agent starts. It holds no Git, no database and no account: it passes
// the agent's MCP messages to the running app over the profile's private socket and passes the
// answers back. stdout carries MCP messages and nothing else; anything for a person goes to stderr.

const NOT_RUNNING =
  'gitdesk is not open, or MCP access is turned off in Settings › MCP. Open gitdesk, turn it on, then reconnect.';

type Streams = {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
};

async function connect(userData: string): Promise<net.Socket | null> {
  let token: string;
  try {
    token = (await readFile(mcpTokenPath(userData), 'utf8')).trim();
  } catch {
    return null;
  }
  return new Promise((resolve) => {
    const socket = net.connect(mcpSocketPath(userData));
    socket.once('error', () => resolve(null));
    socket.once('connect', () => {
      socket.removeAllListeners('error');
      const hello: Hello = { gitdesk: 1, token };
      socket.write(`${JSON.stringify(hello)}\n`);
      resolve(socket);
    });
  });
}

// With no app to talk to, every request still gets an answer, so the agent shows a reason
// instead of hanging until its own timeout.
function refuseAll({ stdin, stdout }: Streams): Promise<number> {
  return new Promise((resolve) => {
    let buffer = '';
    stdin.setEncoding('utf8');
    stdin.on('data', (chunk: string) => {
      buffer += chunk;
      for (
        let end = buffer.indexOf('\n');
        end >= 0;
        end = buffer.indexOf('\n')
      ) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (!line) continue;
        try {
          const message = JSON.parse(line) as { id?: unknown };
          // Notifications have no id and take no answer.
          if (message.id !== undefined && message.id !== null)
            stdout.write(
              `${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: NOT_RUNNING } })}\n`,
            );
        } catch {
          // Not JSON: nothing to answer.
        }
      }
      // A line with no end is not MCP; stop buffering it.
      if (buffer.length > 1024 * 1024) buffer = '';
    });
    stdin.on('end', () => resolve(1));
  });
}

// Resolves with the exit code once the agent closes its side or the app goes away.
export async function runMcpProxy(
  userData: string,
  streams: Streams = process,
): Promise<number> {
  const socket = await connect(userData);
  if (!socket) {
    streams.stderr.write(`${NOT_RUNNING}\n`);
    return refuseAll(streams);
  }
  return new Promise((resolve) => {
    streams.stdin.pipe(socket);
    socket.pipe(streams.stdout, { end: false });
    socket.on('error', () => undefined);
    let agentLeft = false;
    socket.once('close', () => {
      // Only worth a line when gitdesk went away first (it quit, or MCP was turned off).
      if (!agentLeft) streams.stderr.write('gitdesk closed the connection.\n');
      // The process exits on this promise; the last answer has to be out of stdout first.
      streams.stdout.write('', () => resolve(0));
    });
    streams.stdin.once('end', () => {
      agentLeft = true;
      socket.end();
    });
  });
}

export const isMcpInvocation = (argv: string[]) => argv.includes('--mcp');
