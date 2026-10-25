import type { AuthStatus } from '../../shared/ipc';
import type { Settings } from '../../shared/settings';
import {
  mib,
  SOURCE_LIMITS,
  type Remote,
  type RemoteProblem,
  type RemoteSaveResult,
  type RemoteSourceBranches,
  type RemoteSourceFile,
  type RemoteSourceListResult,
  type SourceEntry,
  type SourceFile,
} from '../../shared/source';
import {
  ApiRequestError,
  NetworkError,
  type ApiClient,
} from '../auth/api-client';

type Log = { warn: (...args: unknown[]) => void };

// The Worker's codes as the problem the Files tab explains. Anything unexpected is 'failed',
// with the detail kept in the log, never shown.
export function problemOf(err: unknown, log?: Log): RemoteProblem {
  if (err instanceof NetworkError) return 'offline';
  if (err instanceof ApiRequestError) {
    if (err.status === 401) return 'signed-out';
    if (err.status === 429) return 'rate-limited';
    if (err.code === 'GIT_HOSTING_UNAVAILABLE') return 'hosting-off';
    if (err.code === 'REF_NOT_FOUND') return 'ref-gone';
    if (err.code === 'PATH_NOT_FOUND') return 'path-gone';
    if (err.code === 'INVALID_STATE') return 'not-ready';
    if (err.code === 'NOT_FOUND') return 'not-found';
  }
  log?.warn('remote source request failed', err);
  return 'failed';
}

function toFile(
  blob: Awaited<ReturnType<ApiClient['sourceBlob']>>,
  force: boolean,
): SourceFile {
  if (blob.kind === 'text') {
    const crlf = (blob.text.match(/\r\n/g) ?? []).length;
    const lf = (blob.text.match(/\n/g) ?? []).length - crlf;
    return {
      kind: 'text',
      text: crlf ? blob.text.replace(/\r\n/g, '\n') : blob.text,
      size: blob.size,
      oid: blob.oid,
      eol: crlf && lf ? 'mixed' : crlf ? 'crlf' : lf ? 'lf' : 'none',
    };
  }
  if (blob.kind === 'image')
    return {
      kind: 'image',
      mime: blob.mime,
      size: blob.size,
      dataUrl: `data:${blob.mime};base64,${blob.base64}`,
    };
  if (blob.kind === 'binary')
    return { kind: 'binary', size: blob.size, reason: blob.reason };
  if (blob.kind === 'too-large')
    return {
      kind: 'too-large',
      size: blob.size,
      limit: blob.limit,
      canForce:
        !force && blob.size !== null && blob.size <= SOURCE_LIMITS.maxText,
    };
  return { kind: 'binary', size: blob.size, reason: 'binary' };
}

export function createRemoteSource(deps: {
  api: Pick<ApiClient, 'sourceBranches' | 'sourceTree' | 'sourceBlob'>;
  auth: {
    getStatus: () => AuthStatus;
    authorized: <T>(fn: (token: string) => Promise<T>) => Promise<T>;
  };
  settings: () => Settings;
  // Asks where to save in main's own dialog and writes there; false when the person cancels.
  saveFile: (suggestedName: string, bytes: Buffer) => Promise<boolean>;
  log?: Log;
}) {
  async function run<T extends object>(
    work: () => Promise<T>,
  ): Promise<Remote<T>> {
    if (deps.settings().localOnly) return { ok: false, problem: 'local-only' };
    if (deps.auth.getStatus().status !== 'authenticated')
      return { ok: false, problem: 'signed-out' };
    try {
      return { ok: true, ...(await work()) };
    } catch (err) {
      return { ok: false, problem: problemOf(err, deps.log) };
    }
  }

  return {
    branches: (id: string): Promise<RemoteSourceBranches> =>
      run(() =>
        deps.auth.authorized((token) => deps.api.sourceBranches(token, id)),
      ),

    list(input: {
      id: string;
      ref: string;
      path: string;
      cursor: string | null;
    }): Promise<RemoteSourceListResult> {
      return run(async () => {
        const page = await deps.auth.authorized((token) =>
          deps.api.sourceTree(token, input.id, input),
        );
        const prefix = input.path ? `${input.path}/` : '';
        // Every entry must sit directly in the folder that was asked for.
        const entries: SourceEntry[] = page.entries
          .filter((e) => e.path === `${prefix}${e.name}`)
          .map((e) => ({
            name: e.name,
            path: e.path,
            type: e.type,
            size: null,
            oid: e.oid,
            status: null,
            ignored: false,
            changes: false,
          }));
        return { commit: page.commit, entries, nextCursor: page.nextCursor };
      });
    },

    read(input: {
      id: string;
      oid: string;
      path: string;
      limitMiB: 1 | 2 | 5;
      force: boolean;
    }): Promise<RemoteSourceFile> {
      return run(async () => {
        const blob = await deps.auth.authorized((token) =>
          deps.api.sourceBlob(token, input.id, input.oid, {
            path: input.path,
            max: input.force ? SOURCE_LIMITS.maxText / mib(1) : input.limitMiB,
            raw: false,
          }),
        );
        return { file: toFile(blob, input.force) };
      });
    },

    save(input: {
      id: string;
      oid: string;
      path: string;
    }): Promise<RemoteSaveResult> {
      return run(async () => {
        const blob = await deps.auth.authorized((token) =>
          deps.api.sourceBlob(token, input.id, input.oid, {
            path: input.path,
            max: 5,
            raw: true,
          }),
        );
        if (blob.kind !== 'raw') return { outcome: 'too-large' as const };
        const name = input.path.slice(input.path.lastIndexOf('/') + 1);
        const saved = await deps.saveFile(
          name,
          Buffer.from(blob.base64, 'base64'),
        );
        return { outcome: saved ? ('saved' as const) : ('cancelled' as const) };
      });
    },
  };
}

export type RemoteSource = ReturnType<typeof createRemoteSource>;
