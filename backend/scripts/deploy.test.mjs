import assert from 'node:assert/strict';
import test from 'node:test';
import { productionConfig } from './deploy.mjs';

const fixture = '00000000000000000000000000000001';
const namespace = (env) => env.kv_namespaces.find((kv) => kv.binding === 'OAUTH_KV').id;

test('the production release uses only the supplied namespace', () => {
  const config = productionConfig(fixture);
  assert.equal(namespace(config), fixture);
  assert.notEqual(namespace(config.env.dev), fixture);
  assert.equal(config.name, 'gitdesk-api');
});

test('missing, malformed and development namespace IDs stop before deployment', () => {
  const devId = namespace(productionConfig(fixture).env.dev);
  for (const id of [undefined, '', '$GITDESK_PRODUCTION_OAUTH_KV_ID', 'not-an-id', devId, devId.toUpperCase()]) {
    assert.throws(() => productionConfig(id), /existing production KV namespace ID/);
  }
});
