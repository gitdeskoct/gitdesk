import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { call, fakeGoogle, postJson, signIn } from './helpers';

type Activity = {
  id: string;
  type: string;
  repositoryId: string | null;
  repositoryName: string;
  createdAt: number;
};
type Page = { activity: Activity[]; nextCursor: string | null };

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function setup() {
  const google = await fakeGoogle();
  const app = createApp({ google: google.provider });
  google.state.claims = { ...google.state.claims, sub: `activity-${crypto.randomUUID()}` };
  const owner = await signIn(app, google, '198.51.100.50');
  google.state.claims = { ...google.state.claims, sub: `activity-${crypto.randomUUID()}` };
  const other = await signIn(app, google, '198.51.100.51');
  const get = async <T>(token: string, path: string) => {
    const res = await call(app, path, { headers: bearer(token) });
    return { status: res.status, body: (await res.json()) as T };
  };
  const write = (method: string, path: string, body?: unknown) =>
    call(app, path, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: { 'content-type': 'application/json', ...bearer(owner.access_token) },
    });
  return { app, owner, other, get, write };
}

describe('activity', () => {
  it('requires a signed-in session', async () => {
    const { app } = await setup();
    expect((await call(app, '/api/v1/activity')).status).toBe(401);
  });

  it('records create, update and delete, newest first, for the owner only', async () => {
    const { app, owner, other, get, write } = await setup();
    const created = await postJson(app, '/api/v1/repositories', { name: 'log' }, undefined, bearer(owner.access_token));
    const { repository } = (await created.json()) as { repository: { id: string } };
    const path = `/api/v1/repositories/${repository.id}`;
    expect((await write('PATCH', path, { name: 'journal' })).status).toBe(200);
    // Failed writes log nothing.
    expect((await write('PATCH', path, { name: 'CON' })).status).toBe(400);
    expect((await write('DELETE', path)).status).toBe(204);
    expect((await write('DELETE', path)).status).toBe(404);

    const all = await get<Page>(owner.access_token, '/api/v1/activity');
    // Provisioning can land in the same millisecond as the create, so its place among them isn't fixed.
    const types = all.body.activity.map((a) => [a.type, a.repositoryName]);
    expect(types.filter(([type]) => type !== 'repository.provisioned')).toEqual([
      ['repository.deleted', 'journal'],
      ['repository.updated', 'journal'],
      ['repository.created', 'log'],
    ]);
    expect(types).toContainEqual(['repository.provisioned', 'log']);
    // The repository is gone, so every row's reference was cleared.
    expect(all.body.activity.every((a) => a.repositoryId === null)).toBe(true);

    const page1 = await get<Page>(owner.access_token, '/api/v1/activity?limit=2');
    expect(page1.body.activity).toEqual(all.body.activity.slice(0, 2));
    const page2 = await get<Page>(
      owner.access_token,
      `/api/v1/activity?limit=2&cursor=${page1.body.nextCursor}`,
    );
    expect(page2.body).toEqual({ activity: all.body.activity.slice(2), nextCursor: null });

    const bad = await get(owner.access_token, '/api/v1/activity?cursor=abc');
    expect(bad).toMatchObject({ status: 400, body: { error: { code: 'VALIDATION_FAILED' } } });

    expect((await get<Page>(other.access_token, '/api/v1/activity')).body.activity).toEqual([]);
    const overview = await get<{ recentActivity: Activity[] }>(
      owner.access_token,
      '/api/v1/dashboard/overview',
    );
    expect(overview.body.recentActivity).toEqual(all.body.activity);
  });
});
