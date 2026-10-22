import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { call, fakeGoogle, postJson } from './helpers';

describe('app middleware', () => {
  it('generates the request id itself, ignoring the client header', async () => {
    const app = createApp({ google: (await fakeGoogle()).provider });
    const res = await call(app, '/nowhere', { headers: { 'x-request-id': 'client-chosen-id' } });
    const { error } = (await res.json()) as { error: { requestId: string } };
    expect(error.requestId).not.toBe('client-chosen-id');
    expect(error.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers.get('x-request-id')).toBe(error.requestId);
  });

  it('rejects bodies over 8 KB with 413', async () => {
    const app = createApp({ google: (await fakeGoogle()).provider });
    const res = await postJson(app, '/api/v1/repositories', { name: 'x'.repeat(9 * 1024) });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: { code: 'PAYLOAD_TOO_LARGE' } });
  });

  it('refuses plain http except on the local machine', async () => {
    const app = createApp({ google: (await fakeGoogle()).provider });
    const plain = await call(app, 'http://gitdesk-api.example.workers.dev/health');
    expect(plain.status).toBe(403);
    expect(await plain.json()).toMatchObject({ error: { code: 'HTTPS_REQUIRED' } });
    expect((await call(app, 'https://gitdesk-api.example.workers.dev/health')).status).toBe(200);
    expect((await call(app, 'http://localhost:8787/health')).status).toBe(200);
    expect((await call(app, 'http://127.0.0.1:8787/health')).status).toBe(200);
  });
});
