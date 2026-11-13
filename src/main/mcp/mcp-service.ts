import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  APPROVAL_TIMEOUT_MS,
  type McpApproval,
  type McpCall,
  type McpLocalStatus,
  type McpRemoteStatus,
} from '../../shared/mcp';
import type { AppNotice } from '../../shared/ipc';
import { repoIdSchema } from '../../shared/repos';
import type { Settings } from '../../shared/settings';
import {
  ApiRequestError,
  NetworkError,
  type ApiClient,
} from '../auth/api-client';
import { readState, writeState, type AppDatabase } from '../db/database';
import { UserError } from '../errors';
import {
  startLocalServer,
  type Connection,
  type LocalServer,
} from './local-server';
import {
  buildLocalServer,
  type ApprovalAnswer,
  type ApprovalRequest,
  type LocalPolicy,
  type LocalServices,
} from './local-tools';

const ALLOWLIST_KEY = 'mcp.repositories';
const allowlistSchema = z.array(repoIdSchema).max(500);
// What the page lists, and what is kept.
const CALLS_SHOWN = 20;
const CALLS_KEPT_MS = 90 * 24 * 60 * 60_000;
// One agent can't bury the window in questions, nor keep another agent's out.
const MAX_PENDING_PER_CONNECTION = 5;
const MAX_PENDING = 20;

type Pending = {
  approval: McpApproval;
  connection: string;
  settle: (answer: ApprovalAnswer) => void;
  timer: ReturnType<typeof setTimeout>;
};

export function createMcpService(deps: {
  db: AppDatabase;
  userData: string;
  settings: () => Settings;
  services: LocalServices;
  // The program an agent starts, and any environment it needs to find this profile.
  launch: { command: string; args: string[]; env: Record<string, string> };
  account: {
    signedIn: () => boolean;
    call: <T>(fn: (token: string) => Promise<T>) => Promise<T>;
    api: Pick<
      ApiClient,
      'mcpStatus' | 'mcpGrants' | 'mcpRevokeGrant' | 'mcpAudit'
    >;
  };
  copyText: (text: string) => void;
  notify: (notice: AppNotice) => void;
  emit: (status: McpLocalStatus) => void;
  log: { warn: (message: string, error?: unknown) => void };
  // Tests replace the socket.
  start?: typeof startLocalServer;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  const start = deps.start ?? startLocalServer;
  const pending = new Map<string, Pending>();
  let server: LocalServer | null = null;
  let error: string | null = null;
  // Start and stop run one after the other, so a quick off-on never leaves two sockets.
  let chain: Promise<void> = Promise.resolve();
  let knownRepositories: string | null = null;

  function allowlist(): string[] {
    const parsed = allowlistSchema.safeParse(readState(deps.db, ALLOWLIST_KEY));
    return parsed.success ? parsed.data : [];
  }

  async function shared(): Promise<string[]> {
    const ids = new Set(
      (await deps.services.repos.list()).map((repo) => repo.id),
    );
    return allowlist().filter((id) => ids.has(id));
  }

  async function status(): Promise<McpLocalStatus> {
    const settings = deps.settings();
    return {
      enabled: settings.mcpLocal,
      listening: server !== null,
      error,
      writes: settings.mcpLocalWrites,
      command: deps.launch.command,
      args: deps.launch.args,
      repositories: await shared(),
      clients: server?.clients() ?? [],
      approvals: [...pending.values()].map((item) => item.approval),
    };
  }

  const changed = () =>
    void status()
      .then(deps.emit)
      .catch(() => undefined);

  function settleAll(answer: ApprovalAnswer) {
    for (const item of pending.values()) item.settle(answer);
  }

  function record(call: Omit<McpCall, 'id' | 'at'>) {
    deps.db
      .prepare(
        `INSERT INTO mcp_calls (id, client, tool, repository_name, outcome, reason, at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        call.client,
        call.tool,
        call.repositoryName,
        call.outcome,
        call.reason,
        now(),
      );
    deps.db
      .prepare('DELETE FROM mcp_calls WHERE at < ?')
      .run(now() - CALLS_KEPT_MS);
  }

  const policy: LocalPolicy = {
    allowed: (id) => allowlist().includes(id),
    enabled: () => deps.settings().mcpLocal,
    writes: () => deps.settings().mcpLocal && deps.settings().mcpLocalWrites,
    approve(request: ApprovalRequest) {
      const { signal, connection, ...shown } = request;
      // An agent that already left, or cancelled, is not asked about.
      if (signal.aborted) return Promise.resolve('withdrawn');
      const mine = [...pending.values()].filter(
        (item) => item.connection === connection,
      ).length;
      if (mine >= MAX_PENDING_PER_CONNECTION || pending.size >= MAX_PENDING)
        throw new UserError(
          'Other changes are still waiting for an answer in gitdesk. Wait for those first.',
        );
      const at = now();
      const approval: McpApproval = {
        id: randomUUID(),
        ...shown,
        requestedAt: at,
        expiresAt: at + APPROVAL_TIMEOUT_MS,
      };
      return new Promise<ApprovalAnswer>((resolve) => {
        const withdraw = () => settle('withdrawn');
        const settle = (answer: ApprovalAnswer) => {
          const item = pending.get(approval.id);
          if (!item) return;
          clearTimeout(item.timer);
          signal.removeEventListener('abort', withdraw);
          pending.delete(approval.id);
          changed();
          resolve(answer);
        };
        pending.set(approval.id, {
          approval,
          connection,
          settle,
          timer: setTimeout(() => settle('timed-out'), APPROVAL_TIMEOUT_MS),
        });
        signal.addEventListener('abort', withdraw, { once: true });
        changed();
        deps.notify({
          // The name is the agent's own claim about itself.
          title: `${request.client} (as it calls itself) wants to change ${request.repositoryName}`,
          body: `${request.summary}. Allow or deny it in gitdesk.`,
          tone: 'info',
          repositoryId: request.repositoryId,
          // Each question is its own notice; a second one is not swallowed as a repeat.
          key: approval.id,
        });
      });
    },
    record,
    log: (message, cause) => deps.log.warn(message, cause),
  };

  const build = (connection: Connection) =>
    buildLocalServer(deps.services, policy, connection);

  function apply(): Promise<void> {
    chain = chain.then(async () => {
      const want = deps.settings().mcpLocal;
      if (want && !server) {
        try {
          server = await start({
            userData: deps.userData,
            build,
            onChange: changed,
            log: (message, cause) => deps.log.warn(message, cause),
          });
          error = null;
        } catch (cause) {
          deps.log.warn('MCP socket could not be opened', cause);
          error =
            "gitdesk couldn't open its local connection for agents. Turn it off and on again; if it stays this way, restart gitdesk.";
        }
      } else if (!want && server) {
        // An agent waiting on an answer gets its refusal before the connection goes.
        if (pending.size) {
          settleAll('denied');
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        const closing = server;
        server = null;
        await closing.close().catch(() => undefined);
        error = null;
      }
      if (!deps.settings().mcpLocalWrites) settleAll('denied');
      changed();
    });
    return chain;
  }

  async function remoteCall<T>(
    fn: (token: string) => Promise<T>,
    fallback: string,
  ): Promise<T> {
    if (deps.settings().localOnly || !deps.account.signedIn())
      throw new UserError(
        'Sign in to manage agents connected to your account.',
      );
    try {
      return await deps.account.call(fn);
    } catch (cause) {
      if (cause instanceof NetworkError)
        throw new UserError("Can't reach the gitdesk server.");
      if (cause instanceof ApiRequestError && cause.code === 'RATE_LIMITED')
        throw new UserError('Too many requests. Try again in a minute.');
      if (cause instanceof ApiRequestError && cause.code === 'NOT_FOUND')
        throw new UserError(
          'That agent is no longer connected. It may have been revoked already.',
        );
      deps.log.warn('MCP account request failed', cause);
      throw new UserError(fallback);
    }
  }

  return {
    status,
    applySettings: apply,
    start: apply,

    async setRepositories(ids: string[]): Promise<McpLocalStatus> {
      const have = new Set((await deps.services.repos.list()).map((r) => r.id));
      writeState(
        deps.db,
        ALLOWLIST_KEY,
        [...new Set(ids)].filter((id) => have.has(id)),
      );
      const next = await status();
      deps.emit(next);
      return next;
    },

    async copyConfig(): Promise<void> {
      const { command, args, env } = deps.launch;
      deps.copyText(
        JSON.stringify(
          {
            mcpServers: {
              gitdesk: {
                command,
                args,
                ...(Object.keys(env).length ? { env } : {}),
              },
            },
          },
          null,
          2,
        ),
      );
    },

    calls(): McpCall[] {
      return (
        deps.db
          .prepare(
            `SELECT id, client, tool, repository_name, outcome, reason, at
             FROM mcp_calls ORDER BY at DESC, id DESC LIMIT ?`,
          )
          .all(CALLS_SHOWN) as {
          id: string;
          client: string;
          tool: string;
          repository_name: string | null;
          outcome: McpCall['outcome'];
          reason: string | null;
          at: number;
        }[]
      ).map((row) => ({
        id: row.id,
        client: row.client,
        tool: row.tool,
        repositoryName: row.repository_name,
        outcome: row.outcome,
        reason: row.reason,
        at: row.at,
      }));
    },

    async decide(input: {
      id: string;
      allow: boolean;
    }): Promise<McpLocalStatus> {
      const item = pending.get(input.id);
      // Answered, timed out or withdrawn meanwhile: the page just shows what is left.
      item?.settle(input.allow ? 'allowed' : 'denied');
      return status();
    },

    async remoteStatus(): Promise<McpRemoteStatus> {
      const [info, grants, audit] = await remoteCall(
        (token) =>
          Promise.all([
            deps.account.api.mcpStatus(token),
            deps.account.api.mcpGrants(token),
            deps.account.api.mcpAudit(token),
          ]),
        "Couldn't load the agents connected to your account.",
      );
      return {
        endpoint: info.endpoint,
        grants: grants.grants,
        more: grants.more,
        calls: audit.events.map((event) => ({
          id: event.id,
          client: event.clientName,
          tool: event.tool,
          repositoryName: null,
          outcome: event.outcome,
          reason: event.reason,
          at: event.createdAt,
        })),
      };
    },

    async revokeGrant(id: string): Promise<void> {
      await remoteCall(
        (token) => deps.account.api.mcpRevokeGrant(token, id),
        "Couldn't revoke that agent. Try again.",
      );
    },

    // A repository that left gitdesk leaves the allowlist with it. Status refreshes come often;
    // only a change in which repositories exist is passed on.
    repositoriesChanged(ids: string[]) {
      const key = [...ids].sort().join(',');
      if (key === knownRepositories) return;
      const first = knownRepositories === null;
      knownRepositories = key;
      if (!first) changed();
    },

    async dispose(): Promise<void> {
      // The token and socket files go at once: quitting doesn't wait for the close below.
      server?.removeFiles();
      settleAll('denied');
      await chain.catch(() => undefined);
      await server?.close().catch(() => undefined);
      server = null;
    },
  };
}

export type McpService = ReturnType<typeof createMcpService>;
