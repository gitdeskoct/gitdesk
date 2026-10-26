const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { parseMetadata, verify, writeSums } = require('./verify-release.cjs');

const sha512 = (text) =>
  crypto.createHash('sha512').update(text).digest('base64');

function release(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-'));
  const files = {
    'gitdesk-1.2.0-win-x64.exe': 'exe',
    'gitdesk-1.2.0-win-x64.exe.blockmap': 'map',
    'gitdesk-1.2.0-linux-x86_64.AppImage': 'appimage',
    'gitdesk-1.2.0-linux-amd64.deb': 'deb',
    'gitdesk-1.2.0-linux-x64.pacman': 'pacman',
    'gitdesk-1.2.0-linux-x64.tar.gz': 'tar',
    'gitdesk.nix': 'nix',
    ...overrides,
  };
  for (const [name, body] of Object.entries(files))
    if (body !== null) fs.writeFileSync(path.join(dir, name), body);
  const entry = (url, body) =>
    `  - url: ${url}\n    sha512: ${sha512(body)}\n    size: ${Buffer.byteLength(body)}\n`;
  fs.writeFileSync(
    path.join(dir, 'latest.yml'),
    `version: 1.2.0\nfiles:\n${entry('gitdesk-1.2.0-win-x64.exe', 'exe')}path: gitdesk-1.2.0-win-x64.exe\nsha512: ${sha512('exe')}\nreleaseDate: '2026-11-03T10:00:00.000Z'\n`,
  );
  fs.writeFileSync(
    path.join(dir, 'latest-linux.yml'),
    `version: 1.2.0\nfiles:\n${entry('gitdesk-1.2.0-linux-x86_64.AppImage', 'appimage')}${entry('gitdesk-1.2.0-linux-amd64.deb', 'deb')}path: gitdesk-1.2.0-linux-x86_64.AppImage\n`,
  );
  return dir;
}

test('reads the files electron-builder lists', () => {
  const parsed = parseMetadata(
    "version: 1.2.0\nfiles:\n  - url: a.exe\n    sha512: abc==\n    size: 3\npath: a.exe\nsha512: abc==\nreleaseDate: '2026'\n",
  );
  assert.equal(parsed.version, '1.2.0');
  assert.deepEqual(parsed.files, [{ url: 'a.exe', sha512: 'abc==', size: 3 }]);
});

test('a complete release passes and gets a checksum file', () => {
  const dir = release();
  const { names, problems } = verify(dir, '1.2.0');
  assert.deepEqual(problems, []);
  writeSums(dir, names);
  const sums = fs.readFileSync(path.join(dir, 'SHA256SUMS.txt'), 'utf8');
  assert.equal(sums.trim().split('\n').length, names.length);
});

test('a changed file, a missing target and a wrong version all fail', () => {
  const dir = release({
    'gitdesk-1.2.0-win-x64.exe': 'tampered',
    'gitdesk-1.2.0-linux-x64.pacman': null,
  });
  const { problems } = verify(dir, '1.3.0');
  assert.ok(problems.some((p) => p.includes("doesn't match the SHA-512")));
  assert.ok(problems.some((p) => p.startsWith('Arch package')));
  assert.ok(problems.some((p) => p.includes('not 1.3.0')));
});
