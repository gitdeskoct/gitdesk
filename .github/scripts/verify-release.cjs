// Checks a folder of release files before the draft is made: one of each expected file, every file
// named for this version, and every file the updater metadata lists matching its SHA-512 and size.
// Writes SHA256SUMS.txt beside them. Usage: node verify-release.cjs <dir> <version>

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const EXPECTED = [
  { kind: 'Windows installer', test: (name) => name.endsWith('.exe') },
  { kind: 'Windows blockmap', test: (name) => name.endsWith('.exe.blockmap') },
  { kind: 'AppImage', test: (name) => name.endsWith('.AppImage') },
  { kind: 'Debian package', test: (name) => name.endsWith('.deb') },
  { kind: 'Arch package', test: (name) => name.endsWith('.pacman') },
  { kind: 'Archive', test: (name) => name.endsWith('.tar.gz') },
  { kind: 'Windows update metadata', test: (name) => name === 'latest.yml' },
  {
    kind: 'Linux update metadata',
    test: (name) => name === 'latest-linux.yml',
  },
  { kind: 'Nix expression', test: (name) => name === 'gitdesk.nix' },
];

// electron-builder's metadata is a fixed shape, so a line reader is enough and needs no YAML package.
function parseMetadata(text) {
  const version = /^version:\s*['"]?([^'"\s]+)/m.exec(text)?.[1] ?? null;
  const files = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const url = /^\s*-\s*url:\s*['"]?([^'"]+?)['"]?\s*$/.exec(line);
    if (url) {
      current = { url: url[1] };
      files.push(current);
      continue;
    }
    if (!current) continue;
    const sha = /^\s+sha512:\s*['"]?([^'"\s]+)/.exec(line);
    if (sha) current.sha512 = sha[1];
    const size = /^\s+size:\s*(\d+)/.exec(line);
    if (size) current.size = Number(size[1]);
    if (/^\S/.test(line)) current = null;
  }
  return { version, files };
}

const digest = (file, algorithm, encoding) =>
  crypto.createHash(algorithm).update(fs.readFileSync(file)).digest(encoding);

function verify(dir, version) {
  const names = fs.readdirSync(dir).filter((name) => name !== 'SHA256SUMS.txt');
  const problems = [];
  for (const { kind, test } of EXPECTED) {
    const found = names.filter(test);
    if (found.length !== 1)
      problems.push(`${kind}: expected one file, found ${found.length}`);
  }
  for (const name of names) {
    if (
      !name.endsWith('.yml') &&
      !name.endsWith('.nix') &&
      !name.includes(version)
    )
      problems.push(`${name} isn't named for version ${version}`);
  }
  for (const [metadata, required] of [
    ['latest.yml', /\.exe$/],
    ['latest-linux.yml', /\.AppImage$/],
  ]) {
    const file = path.join(dir, metadata);
    if (!fs.existsSync(file)) continue;
    const parsed = parseMetadata(fs.readFileSync(file, 'utf8'));
    if (parsed.version !== version)
      problems.push(
        `${metadata} says version ${parsed.version}, not ${version}`,
      );
    if (!parsed.files.some((entry) => required.test(entry.url)))
      problems.push(`${metadata} doesn't list the ${required.source} file`);
    for (const entry of parsed.files) {
      const target = path.join(dir, entry.url);
      if (!fs.existsSync(target)) {
        problems.push(`${metadata} lists ${entry.url}, which isn't here`);
        continue;
      }
      if (entry.sha512 !== digest(target, 'sha512', 'base64'))
        problems.push(`${entry.url} doesn't match the SHA-512 in ${metadata}`);
      if (entry.size !== undefined && entry.size !== fs.statSync(target).size)
        problems.push(`${entry.url} doesn't match the size in ${metadata}`);
    }
  }
  return { names, problems };
}

function writeSums(dir, names) {
  const lines = [...names]
    .sort()
    .map((name) => `${digest(path.join(dir, name), 'sha256', 'hex')}  ${name}`);
  fs.writeFileSync(path.join(dir, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`);
}

if (require.main === module) {
  const [dir, version] = process.argv.slice(2);
  if (!dir || !version) {
    console.error('Usage: node verify-release.cjs <dir> <version>');
    process.exit(2);
  }
  const { names, problems } = verify(dir, version);
  if (problems.length) {
    for (const problem of problems) console.error(`::error::${problem}`);
    process.exit(1);
  }
  writeSums(dir, names);
  console.log(`Checked ${names.length} files for ${version}:`);
  for (const name of [...names].sort()) console.log(`  ${name}`);
}

module.exports = { parseMetadata, verify, writeSums };
