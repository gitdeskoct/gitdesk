import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import ts from 'typescript';

const root = new URL('../', import.meta.url);
const key = 'GITDESK_PRODUCTION_OAUTH_KV_ID';

export function productionConfig(id) {
  const source = readFileSync(new URL('wrangler.jsonc', root), 'utf8');
  const { config, error } = ts.parseConfigFileTextToJson('wrangler.jsonc', source);
  if (error) throw new Error('Cannot parse wrangler.jsonc.');
  const oauth = (env) => env.kv_namespaces?.find((kv) => kv.binding === 'OAUTH_KV');
  const binding = oauth(config);
  const devId = oauth(config.env.dev)?.id;
  if (binding?.id !== `$${key}` || !devId) throw new Error('Check the OAUTH_KV bindings in wrangler.jsonc.');
  if (!id || !/^[a-f0-9]{32}$/i.test(id) || id.toLowerCase() === devId.toLowerCase()) {
    throw new Error(`Set ${key} to the existing production KV namespace ID, not the development ID.`);
  }
  binding.id = id.toLowerCase();
  return config;
}

function deploy() {
  const config = productionConfig(process.env[key]);
  const { values } = parseArgs({ options: {
    'dry-run': { type: 'boolean' }, outdir: { type: 'string' }, 'secrets-file': { type: 'string' },
  } });
  const args = ['deploy', '--minify', '--env='];
  if (values['dry-run']) args.push('--dry-run');
  for (const flag of ['outdir', 'secrets-file']) {
    if (values[flag]) args.push(`--${flag}=${values[flag]}`);
  }
  // Wrangler resolves main and migrations relative to this file. Keep it beside the original.
  const path = fileURLToPath(new URL(`.wrangler-production-${randomUUID()}.json`, root));
  writeFileSync(path, JSON.stringify(config), { flag: 'wx', mode: 0o600 });
  try {
    const wrangler = fileURLToPath(new URL('node_modules/wrangler/bin/wrangler.js', root));
    const result = spawnSync(process.execPath, [wrangler, ...args, '--config', path], { cwd: root, stdio: 'inherit' });
    if (result.error) throw result.error;
    return result.status ?? 1;
  } finally {
    unlinkSync(path);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    process.exitCode = deploy();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
