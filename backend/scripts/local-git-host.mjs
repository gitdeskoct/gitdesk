// Local stand-in for Cloudflare Artifacts during `wrangler dev`. Artifacts has no local simulator
// (Miniflare only proxies it to the real service), so this serves real Git smart HTTP over HTTPS
// through `git http-backend`, checks the same short-lived bearer tokens the Worker mints, and gives
// the Worker a loopback admin API (GIT_HOSTING=local). Development only: never deploy or expose it.
//
// Usage: node scripts/local-git-host.mjs <data dir>
//   LOCAL_GIT_SECRET from the environment or .dev.vars (the Worker reads the same one),
//   GIT_PORT=9443, ADMIN_PORT=9444
// It prints the CA file Git must trust: git -c http.sslBackend=openssl -c http.sslCAInfo=<file>.
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';

const dataDir = path.resolve(process.argv[2] ?? '.local-git-host');
const devVars = existsSync('.dev.vars') ? readFileSync('.dev.vars', 'utf8') : '';
const secret =
  process.env.LOCAL_GIT_SECRET ?? /^LOCAL_GIT_SECRET=(.+)$/m.exec(devVars)?.[1].trim();
const gitPort = Number(process.env.GIT_PORT ?? 9443);
const adminPort = Number(process.env.ADMIN_PORT ?? 9444);
if (!secret || secret.length < 16) throw new Error('Set LOCAL_GIT_SECRET (16+ characters).');

const repoRoot = path.join(dataDir, 'repos');
mkdirSync(repoRoot, { recursive: true });
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const repoDir = (name) => path.join(repoRoot, `${name}.git`);
const git = (dir, args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
const log = (...parts) => console.log(new Date().toISOString(), ...parts);

// Tokens live in memory, keyed by their hash, like Artifacts they expire and can be revoked.
const tokens = new Map();
const hash = (token) => createHash('sha256').update(token).digest('hex');

// A self-signed certificate for 127.0.0.1, made once.
const cert = path.join(dataDir, 'cert.pem');
const key = path.join(dataDir, 'key.pem');
if (!existsSync(cert))
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '30', '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', key, '-out', cert,
  ], { stdio: 'ignore' });

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}));
    req.on('error', reject);
  });
const sameSecret = (value) => {
  const a = Buffer.from(String(value ?? ''));
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
};

// The Worker's side: what GitHost needs, nothing else.
const admin = http.createServer(async (req, res) => {
  const started = Date.now();
  const url = new URL(req.url, 'http://127.0.0.1');
  const parts = url.pathname.split('/').filter(Boolean);
  res.on('finish', () => log('admin', req.method, url.pathname, res.statusCode, `${Date.now() - started}ms`));
  try {
    if (!sameSecret(req.headers['x-local-git-secret'])) return json(res, 401, { error: 'secret' });
    const name = parts[1];
    if (parts[0] !== 'repos' || (name !== undefined && !NAME.test(name)))
      return json(res, 404, { error: 'not found' });
    if (req.method === 'POST' && parts.length === 1) {
      const body = await readBody(req);
      if (!NAME.test(body.name)) return json(res, 400, { error: 'name' });
      const dir = repoDir(body.name);
      if (!existsSync(dir)) {
        execFileSync('git', ['init', '--quiet', '--bare', `--initial-branch=${body.defaultBranch}`, dir]);
        git(dir, ['config', 'http.receivepack', 'true']);
      }
      return json(res, 200, { remote: `https://127.0.0.1:${gitPort}/git/${body.name}.git` });
    }
    if (!name || !existsSync(repoDir(name))) {
      if (req.method === 'DELETE' && parts.length === 2) return json(res, 200, { deleted: false });
      return json(res, 404, { error: 'not found' });
    }
    const dir = repoDir(name);
    if (req.method === 'DELETE' && parts.length === 2) {
      for (const [h, t] of tokens) if (t.name === name) tokens.delete(h);
      rmSync(dir, { recursive: true, force: true });
      return json(res, 200, { deleted: true });
    }
    if (parts[2] === 'tokens' && req.method === 'POST') {
      const { scope, ttlSeconds } = await readBody(req);
      if (!['read', 'write'].includes(scope)) return json(res, 400, { error: 'scope' });
      const token = `local_${randomBytes(24).toString('base64url')}`;
      const expiresAt = Date.now() + Number(ttlSeconds) * 1000;
      tokens.set(hash(token), { name, scope, expiresAt });
      return json(res, 200, { token, expiresAt });
    }
    if (parts[2] === 'tokens' && req.method === 'DELETE') {
      let revoked = 0;
      for (const [h, t] of tokens) if (t.name === name) tokens.delete(h), revoked++;
      return json(res, 200, { revoked });
    }
    if (parts[2] === 'commits' && /^[0-9a-f]{40,64}$/.test(parts[3] ?? '')) {
      let exists = true;
      try {
        git(dir, ['cat-file', '-e', `${parts[3]}^{commit}`]);
      } catch {
        exists = false;
      }
      return json(res, 200, { exists });
    }
    if (parts[2] === 'tip') {
      const ref = url.searchParams.get('ref') ?? '';
      if (!/^refs\/heads\/[^\s~^:?*[\\]+$/.test(ref)) return json(res, 400, { error: 'ref' });
      let oid = null;
      try {
        oid = git(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]) || null;
      } catch {
        oid = null;
      }
      return json(res, 200, { oid });
    }
    // Read-only object access for the Files tab, the same shape Artifacts' readCommit, readTree and
    // readBlob give: one object by id, never a path, so nothing here can leave the repository.
    if (parts[2] === 'objects' && /^[0-9a-f]{40,64}$/.test(parts[3] ?? '') && req.method === 'GET') {
      const oid = parts[3];
      const type = (() => {
        try {
          return git(dir, ['cat-file', '-t', oid]);
        } catch {
          return null;
        }
      })();
      if (parts[4] === 'commit') {
        if (type !== 'commit') return json(res, 200, { commit: null });
        const [hash, tree, author, seconds, ...message] = git(dir, [
          'log', '-1', '--no-color', '--format=%H%x00%T%x00%an%x00%ct%x00%B', oid,
        ]).split('\0');
        return json(res, 200, {
          commit: { oid: hash, treeOid: tree, author, committedAt: Number(seconds), message: message.join('') },
        });
      }
      if (parts[4] === 'tree') {
        if (type !== 'tree') return json(res, 200, { entries: null });
        const out = execFileSync('git', ['ls-tree', '-z', oid], { cwd: dir, encoding: 'utf8' });
        const entries = out.split('\0').filter(Boolean).map((record) => {
          const tab = record.indexOf('\t');
          const [mode, kind, hash] = record.slice(0, tab).split(' ');
          const type =
            kind === 'tree' ? 'tree' : kind === 'commit' ? 'gitlink' : mode === '120000' ? 'symlink' : mode === '100755' ? 'exec' : 'blob';
          return { name: record.slice(tab + 1), mode, hash, type };
        });
        return json(res, 200, { entries });
      }
      if (parts[4] === 'blob') {
        if (type !== 'blob') return json(res, 200, { blob: null });
        const max = Math.min(Number(url.searchParams.get('max') ?? 0) || 0, 8 * 1024 * 1024);
        const size = Number(git(dir, ['cat-file', '-s', oid]));
        const bytes = size <= max ? execFileSync('git', ['cat-file', 'blob', oid], { cwd: dir, maxBuffer: max + 1 }) : null;
        return json(res, 200, { blob: { size, base64: bytes ? bytes.toString('base64') : null } });
      }
    }
    return json(res, 404, { error: 'not found' });
  } catch (err) {
    log('admin error', err.message);
    return json(res, 500, { error: 'failed' });
  }
});

// Git's side: smart HTTP through git http-backend, after the bearer token is checked.
const gitServer = https.createServer({ cert: readFileSync(cert), key: readFileSync(key) }, (req, res) => {
  const started = Date.now();
  const url = new URL(req.url, `https://127.0.0.1:${gitPort}`);
  const match = /^\/git\/([^/]+)\.git(\/.*)$/.exec(url.pathname);
  const deny = (status, message) => {
    res.writeHead(status, { 'content-type': 'text/plain' });
    res.end(`${message}\n`);
  };
  res.on('finish', () =>
    log('git', req.method, url.pathname, url.searchParams.get('service') ?? '', res.statusCode, `${Date.now() - started}ms`),
  );
  if (!match || !NAME.test(match[1]) || !existsSync(repoDir(match[1]))) return deny(404, 'Repository not found');
  const [, name, rest] = match;
  const bearer = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1];
  const grant = bearer && tokens.get(hash(bearer));
  if (!grant || grant.name !== name || grant.expiresAt < Date.now()) {
    res.writeHead(401, { 'www-authenticate': 'Bearer realm="gitdesk-local"', 'content-type': 'text/plain' });
    return res.end('Authentication failed\n');
  }
  const writing = url.searchParams.get('service') === 'git-receive-pack' || rest === '/git-receive-pack';
  if (writing && grant.scope !== 'write') return deny(403, 'This token can only read.');

  const cgi = spawn('git', ['http-backend'], {
    env: {
      PATH: process.env.PATH,
      SYSTEMROOT: process.env.SYSTEMROOT,
      GIT_PROJECT_ROOT: repoRoot,
      GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: `/${name}.git${rest}`,
      REQUEST_METHOD: req.method,
      QUERY_STRING: url.search.slice(1),
      CONTENT_TYPE: req.headers['content-type'] ?? '',
      HTTP_CONTENT_ENCODING: req.headers['content-encoding'] ?? '',
      GIT_PROTOCOL: req.headers['git-protocol'] ?? '',
      REMOTE_USER: 'gitdesk',
      REMOTE_ADDR: '127.0.0.1',
    },
  });
  req.pipe(cgi.stdin);
  let head = Buffer.alloc(0);
  let sent = false;
  cgi.stdout.on('data', (chunk) => {
    if (sent) return res.write(chunk);
    head = Buffer.concat([head, chunk]);
    const end = head.indexOf('\r\n\r\n');
    if (end < 0) return;
    let status = 200;
    const headers = {};
    for (const line of head.subarray(0, end).toString().split('\r\n')) {
      const i = line.indexOf(':');
      const field = line.slice(0, i).trim();
      const value = line.slice(i + 1).trim();
      if (field.toLowerCase() === 'status') status = Number.parseInt(value, 10);
      else headers[field] = value;
    }
    res.writeHead(status, headers);
    sent = true;
    res.write(head.subarray(end + 4));
  });
  cgi.stderr.on('data', (d) => log('git http-backend:', d.toString().trim()));
  cgi.on('close', () => (sent ? res.end() : deny(500, 'git http-backend failed')));
});

admin.listen(adminPort, '127.0.0.1');
gitServer.listen(gitPort, '127.0.0.1', () => {
  log(`local git host: Git https://127.0.0.1:${gitPort}/git/<name>.git, admin http://127.0.0.1:${adminPort}`);
  log(`trust this certificate in Git: ${cert}`);
});
