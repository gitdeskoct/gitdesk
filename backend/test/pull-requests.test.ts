import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { call, fakeGoogle, postJson, signIn } from './helpers';

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const D = 'd'.repeat(40);

type Pull = {
  id: string;
  number: number;
  status: string;
  latest: { version: number; mergeability: string; conflicts: string[] } | null;
  review: { decision: string; stale: boolean } | null;
  comments: number;
  unresolved: number;
  author: { accountId: string; name: string };
};

let nextIp = 160;

async function setup() {
  const google = await fakeGoogle();
  const app = createApp({ google: google.provider });
  google.state.claims = { ...google.state.claims, sub: `owner-${crypto.randomUUID()}` };
  const owner = await signIn(app, google, `198.51.100.${nextIp++}`);
  google.state.claims = { ...google.state.claims, sub: `other-${crypto.randomUUID()}` };
  const other = await signIn(app, google, `198.51.100.${nextIp++}`);
  const send = (token: string, method: string, path: string, body?: unknown, headers = {}) =>
    call(app, path, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: { 'content-type': 'application/json', ...bearer(token), ...headers },
    });
  const repo = await postJson(app, '/api/v1/repositories', { name: `r-${nextIp}` }, undefined, bearer(owner.access_token));
  const repositoryId = ((await repo.json()) as { repository: { id: string } }).repository.id;
  const create = async (title = 'Improve search', extra: Record<string, unknown> = {}, headers = {}) => {
    const res = await send(
      owner.access_token,
      'POST',
      `/api/v1/repositories/${repositoryId}/pull-requests`,
      { title, description: '', sourceRef: 'feature/search', targetRef: 'main', isDraft: false, ...extra },
      headers,
    );
    return { res, pull: res.ok ? ((await res.clone().json()) as { pullRequest: Pull }).pullRequest : null };
  };
  const pullPath = (id: string, rest = '') => `/api/v1/pull-requests/${id}${rest}`;
  return { app, owner, other, send, repositoryId, create, pullPath };
}

const json = async <T>(res: Response) => (await res.json()) as T;

describe('pull requests', () => {
  it('belong to the repository owner only', async () => {
    const { owner, other, send, repositoryId, create, pullPath } = await setup();
    const list = `/api/v1/repositories/${repositoryId}/pull-requests`;
    expect((await call((await setup()).app, list)).status).toBe(401);
    expect((await send(other.access_token, 'GET', list)).status).toBe(404);
    const { pull } = await create();
    expect(pull!.author.accountId).toBe(owner.account.id);
    for (const [method, path, body] of [
      ['GET', pullPath(pull!.id)],
      ['PATCH', pullPath(pull!.id), { title: 'x' }],
      ['POST', pullPath(pull!.id, '/close')],
      ['GET', pullPath(pull!.id, '/comments')],
      ['POST', pullPath(pull!.id, '/merge-result'), { operationId: crypto.randomUUID(), mergeCommitOid: A, targetOid: B }],
    ] as const)
      expect((await send(other.access_token, method, path, body)).status).toBe(404);
  });

  it('numbers pull requests per repository and returns the first on a retried create', async () => {
    const { create, owner, send, repositoryId } = await setup();
    const key = crypto.randomUUID();
    const first = await create('One', {}, { 'idempotency-key': key });
    const retry = await create('One again', {}, { 'idempotency-key': key });
    const second = await create('Two');
    expect(first.pull!.number).toBe(1);
    expect(retry.pull!.id).toBe(first.pull!.id);
    expect(second.pull!.number).toBe(2);
    expect((await create('Same', { sourceRef: 'main' })).res.status).toBe(400);
    expect((await create('Bad', { sourceRef: '-x' })).res.status).toBe(400);
    expect((await create('Bad', { sourceRef: 'a..b' })).res.status).toBe(400);

    const page = await json<{ pullRequests: Pull[]; nextCursor: string; counts: Record<string, number> }>(
      await send(owner.access_token, 'GET', `/api/v1/repositories/${repositoryId}/pull-requests?limit=1`),
    );
    expect(page.pullRequests.map((p) => p.number)).toEqual([2]);
    expect(page.counts).toEqual({ open: 2, merged: 0, closed: 0 });
    const next = await json<{ pullRequests: Pull[]; nextCursor: string | null }>(
      await send(owner.access_token, 'GET', `/api/v1/repositories/${repositoryId}/pull-requests?limit=1&cursor=${page.nextCursor}`),
    );
    expect(next.pullRequests.map((p) => p.number)).toEqual([1]);
    const found = await json<{ pullRequests: Pull[] }>(
      await send(owner.access_token, 'GET', `/api/v1/repositories/${repositoryId}/pull-requests?q=%23${2}`),
    );
    expect(found.pullRequests.map((p) => p.number)).toEqual([2]);
  });

  it('closes and reopens, and a merged pull request stays merged', async () => {
    const { create, owner, send, pullPath } = await setup();
    const { pull } = await create();
    const closed = await json<{ pullRequest: Pull }>(await send(owner.access_token, 'POST', pullPath(pull!.id, '/close')));
    expect(closed.pullRequest.status).toBe('closed');
    await send(owner.access_token, 'POST', pullPath(pull!.id, '/reopen'));
    const op = { operationId: crypto.randomUUID(), mergeCommitOid: A, targetOid: B };
    expect((await send(owner.access_token, 'POST', pullPath(pull!.id, '/merge-result'), op)).status).toBe(200);
    expect((await send(owner.access_token, 'POST', pullPath(pull!.id, '/reopen'))).status).toBe(409);
    expect((await send(owner.access_token, 'POST', pullPath(pull!.id, '/close'))).status).toBe(409);
    expect((await send(owner.access_token, 'PATCH', pullPath(pull!.id), { title: 'late' })).status).toBe(409);
  });

  it('starts a new snapshot only when a commit moves, and marks an older approval stale', async () => {
    const { create, owner, send, pullPath } = await setup();
    const { pull } = await create();
    const compare = (sourceOid: string, check?: unknown) =>
      send(owner.access_token, 'POST', pullPath(pull!.id, '/comparisons'), {
        sourceOid,
        targetOid: B,
        mergeBaseOid: C,
        ...(check ? { check } : {}),
      });
    let view = (await json<{ pullRequest: Pull }>(await compare(A))).pullRequest;
    expect(view.latest!.version).toBe(1);
    view = (await json<{ pullRequest: Pull }>(
      await compare(A, { mergeability: 'conflicts', reason: null, conflicts: ['src/a.ts'] }),
    )).pullRequest;
    expect(view.latest).toMatchObject({ version: 1, mergeability: 'conflicts', conflicts: ['src/a.ts'] });

    const review = (version: number, sourceOid: string) =>
      send(owner.access_token, 'POST', pullPath(pull!.id, '/reviews'), {
        decision: 'approved',
        body: '',
        comparisonVersion: version,
        sourceOid,
        targetOid: B,
      });
    expect((await review(1, A)).status).toBe(201);
    view = (await json<{ pullRequest: Pull }>(await compare(D))).pullRequest;
    expect(view.latest!.version).toBe(2);
    expect(view.latest!.mergeability).toBe('unknown');
    expect(view.review).toEqual({ decision: 'approved', version: 1, stale: true });
    expect((await review(1, A)).status).toBe(409);
  });

  it('keeps threads one level deep, anchors line comments to a real snapshot, and lets only the author edit', async () => {
    const { create, owner, other, send, pullPath } = await setup();
    const { pull } = await create();
    await send(owner.access_token, 'POST', pullPath(pull!.id, '/comparisons'), { sourceOid: A, targetOid: B, mergeBaseOid: C });
    const comment = (body: Record<string, unknown>) =>
      send(owner.access_token, 'POST', pullPath(pull!.id, '/comments'), { parentCommentId: null, anchor: null, ...body });
    const anchor = {
      comparisonVersion: 1,
      sourceOid: A,
      targetOid: B,
      path: 'src/search.ts',
      side: 'new',
      oldLine: null,
      newLine: 42,
      contextHash: 'e'.repeat(40),
    };
    const top = await json<{ comment: { id: string } }>(await comment({ body: 'Why 50?', anchor }));
    const reply = await comment({ body: 'Enough for now.', parentCommentId: top.comment.id });
    expect(reply.status).toBe(201);
    const nested = await comment({ body: 'nested', parentCommentId: (await json<{ comment: { id: string } }>(reply)).comment.id });
    expect(nested.status).toBe(400);
    expect((await comment({ body: 'x', anchor: { ...anchor, comparisonVersion: 7 } })).status).toBe(409);
    expect((await comment({ body: 'x', anchor: { ...anchor, path: '../etc/passwd' } })).status).toBe(400);

    const path = pullPath(pull!.id, `/comments/${top.comment.id}`);
    expect((await send(other.access_token, 'PATCH', path, { body: 'mine now' })).status).toBe(404);
    const resolved = await json<{ comment: { resolved: boolean } }>(
      await send(owner.access_token, 'PATCH', path, { resolved: true }),
    );
    expect(resolved.comment.resolved).toBe(true);
    expect((await send(owner.access_token, 'DELETE', path)).status).toBe(204);
    const list = await json<{ comments: { deleted: boolean; body: string; anchor: unknown }[] }>(
      await send(owner.access_token, 'GET', pullPath(pull!.id, '/comments')),
    );
    expect(list.comments[0]).toMatchObject({ deleted: true, body: '' });
    expect(list.comments[0]!.anchor).toMatchObject({ path: 'src/search.ts', newLine: 42 });
  });

  it('records a merge once per operation, however often it is reported', async () => {
    const { create, owner, send, pullPath } = await setup();
    const { pull } = await create();
    const op = { operationId: crypto.randomUUID(), mergeCommitOid: A, targetOid: B };
    for (let i = 0; i < 3; i++)
      expect((await send(owner.access_token, 'POST', pullPath(pull!.id, '/merge-result'), op)).status).toBe(200);
    const activity = await json<{ events: { type: string }[] }>(
      await send(owner.access_token, 'GET', pullPath(pull!.id, '/activity')),
    );
    expect(activity.events.filter((e) => e.type === 'merged')).toHaveLength(1);
    const state = await json<{ status: string; mergeCommitOid: string; result: { operationId: string } }>(
      await send(owner.access_token, 'GET', pullPath(pull!.id, '/merge-state')),
    );
    expect(state).toMatchObject({ status: 'merged', mergeCommitOid: A, result: { operationId: op.operationId } });
    const other = await create('Other');
    expect((await send(owner.access_token, 'POST', pullPath(other.pull!.id, '/merge-result'), op)).status).toBe(400);
  });

  it('records desktop events, counts stats and accepts long text only on pull request routes', async () => {
    const { create, owner, send, pullPath, repositoryId } = await setup();
    const { pull } = await create();
    expect(
      (await send(owner.access_token, 'POST', pullPath(pull!.id, '/events'), { type: 'merge_conflicts', detail: '2' })).status,
    ).toBe(204);
    expect(
      (await send(owner.access_token, 'POST', pullPath(pull!.id, '/events'), { type: 'merged', detail: null })).status,
    ).toBe(400);
    await send(owner.access_token, 'POST', pullPath(pull!.id, '/merge-result'), {
      operationId: crypto.randomUUID(),
      mergeCommitOid: A,
      targetOid: B,
    });
    await create('Open one');
    const stats = await json<{ counts: Record<string, number>; merges: number; months: unknown[] }>(
      await send(owner.access_token, 'GET', `/api/v1/repositories/${repositoryId}/pull-requests/stats?range=3m`),
    );
    expect(stats.counts).toEqual({ open: 1, merged: 1, closed: 0 });
    expect(stats.merges).toBe(1);
    expect(stats.months).toHaveLength(3);

    const long = 'x'.repeat(10_000);
    expect((await create('Long', { description: long })).res.status).toBe(201);
    expect((await create('Too long', { description: 'x'.repeat(70_000) })).res.status).toBe(413);
  });
});
