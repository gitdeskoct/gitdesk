// Picks the version a push to main releases. The newest vX.Y.Z tag is the last release; with no
// tag yet, package.json's version is the first. A package.json version above the newest tag was
// set by hand and is released as it is. Otherwise the patch number goes up, or the minor or major
// one when a commit since the last release says #minor or #major (or BREAKING CHANGE). A commit
// that already carries a version tag is that version again, so a rerun builds the same release.
// `[skip release]` in the newest commit's message releases nothing.
// Usage: node next-version.cjs (in a full clone). Writes version, tag and skip to $GITHUB_OUTPUT.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

const parse = (text) => {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(
    text.trim(),
  );
  return match
    ? {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
        prerelease: match[4] ?? null,
      }
    : null;
};
const compareBase = (a, b) =>
  a.major - b.major || a.minor - b.minor || a.patch - b.patch;
const compare = (a, b) =>
  compareBase(a, b) ||
  (a.prerelease === b.prerelease
    ? 0
    : a.prerelease === null
      ? 1
      : b.prerelease === null
        ? -1
        : a.prerelease.localeCompare(b.prerelease, undefined, {
            numeric: true,
          }));

// The highest version tag as written, or null.
function newest(tags) {
  return (
    tags
      .filter((tag) => parse(tag))
      .sort((a, b) => compare(parse(a), parse(b)))
      .at(-1) ?? null
  );
}

function newestStable(tags) {
  return newest(tags.filter((tag) => parse(tag)?.prerelease === null));
}

function bumpOf(messages) {
  if (messages.some((m) => /#major\b|BREAKING[ -]CHANGE/.test(m)))
    return 'major';
  if (messages.some((m) => /#minor\b/.test(m))) return 'minor';
  return 'patch';
}

// Versions with a prerelease suffix are beta releases. Stable versions keep the existing
// automatic bump behavior; a beta version is raised explicitly in package.json.
const versionText = (version) =>
  `${version.major}.${version.minor}.${version.patch}${version.prerelease ? `-${version.prerelease}` : ''}`;

// tag: whether the release still needs its tag; false when the commit already has one.
function nextVersion({
  packageVersion,
  tags,
  headTags,
  headMessage,
  messages,
}) {
  const pkg = parse(packageVersion);
  if (!pkg)
    throw new Error(
      `package.json version ${packageVersion} isn't x.y.z or x.y.z-prerelease`,
    );
  const tagged = newest(headTags);
  if (tagged)
    return {
      version: versionText(parse(tagged)),
      tag: false,
      reason: `this commit is already ${tagged}`,
    };
  if (/\[skip release\]/i.test(headMessage))
    return {
      version: null,
      tag: false,
      reason: 'the commit says [skip release]',
    };
  const last = newestStable(tags);
  if (!last)
    return { version: versionText(pkg), tag: true, reason: 'first release' };
  const lastVersion = parse(last);
  if (pkg.prerelease && compareBase(pkg, lastVersion) >= 0)
    return {
      version: versionText(pkg),
      tag: true,
      reason: `package.json beta version is based on ${last}`,
    };
  if (!pkg.prerelease && compare(pkg, lastVersion) > 0)
    return {
      version: versionText(pkg),
      tag: true,
      reason: `package.json was raised above ${last} by hand`,
    };
  const { major, minor, patch } = lastVersion;
  const bump = bumpOf(messages);
  const next =
    bump === 'major'
      ? { major: major + 1, minor: 0, patch: 0 }
      : bump === 'minor'
        ? { major, minor: minor + 1, patch: 0 }
        : { major, minor, patch: patch + 1 };
  return {
    version: versionText(next),
    tag: true,
    reason: `${bump} after ${last}`,
  };
}

if (require.main === module) {
  const git = (...args) =>
    execFileSync('git', args, { encoding: 'utf8' }).split('\n').filter(Boolean);
  const tags = git('tag', '--list', 'v*');
  const last = newestStable(tags);
  const result = nextVersion({
    packageVersion: JSON.parse(fs.readFileSync('package.json', 'utf8')).version,
    tags,
    headTags: git('tag', '--points-at', 'HEAD', '--list', 'v*'),
    headMessage: execFileSync('git', ['log', '-1', '--format=%B'], {
      encoding: 'utf8',
    }),
    messages: last
      ? execFileSync('git', ['log', '--format=%B%x00', `${last}..HEAD`], {
          encoding: 'utf8',
        }).split('\0')
      : [],
  });
  console.log(
    result.version
      ? `Releasing ${result.version} (${result.reason}).`
      : `Not releasing: ${result.reason}.`,
  );
  if (process.env.GITHUB_OUTPUT)
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      `version=${result.version ?? ''}\ntag=${result.tag}\nskip=${!result.version}\n`,
    );
}

module.exports = { bumpOf, newest, nextVersion };
