// `npm run dev:hosted`: wrangler dev --local with GIT_HOSTING=local. wrangler.jsonc lists the
// required secrets, and locally Wrangler loads only those from .dev.vars, so LOCAL_GIT_SECRET is
// read here and passed as a --var. Extra arguments go to wrangler (for example --port 8787).
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const devVars = existsSync('.dev.vars') ? readFileSync('.dev.vars', 'utf8') : '';
const secret = process.env.LOCAL_GIT_SECRET ?? /^LOCAL_GIT_SECRET=(.+)$/m.exec(devVars)?.[1].trim();
if (!secret || secret.length < 16) {
  console.error('Set LOCAL_GIT_SECRET in .dev.vars (16+ characters); see .dev.vars.example.');
  process.exit(1);
}
const wrangler = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
const child = spawn(
  process.execPath,
  [
    wrangler, 'dev', '--local',
    '--var', 'GIT_HOSTING:local',
    '--var', 'LOCAL_GIT_HOST:http://127.0.0.1:9444',
    '--var', `LOCAL_GIT_SECRET:${secret}`,
    ...process.argv.slice(2),
  ],
  { stdio: 'inherit' },
);
child.on('exit', (code) => process.exit(code ?? 1));
