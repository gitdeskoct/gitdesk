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
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(text.trim());
  return match ? match.slice(1).map(Number) : null;
};
const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

// The highest version tag as written, or null.
function newest(tags) {
  return (
    tags
      .filter((tag) => parse(tag))
      .sort((a, b) => compare(parse(a), parse(b)))
      .at(-1) ?? null
  );
}

function bumpOf(messages) {
  if (messages.some((m) => /#major\b|BREAKING[ -]CHANGE/.test(m)))
    return 'major';
  if (messages.some((m) => /#minor\b/.test(m))) return 'minor';
  return 'patch';
}

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
    throw new Error(`package.json version ${packageVersion} isn't x.y.z`);
  const tagged = newest(headTags);
  if (tagged)
    return {
      version: parse(tagged).join('.'),
      tag: false,
      reason: `this commit is already ${tagged}`,
    };
  if (/\[skip release\]/i.test(headMessage))
    return {
      version: null,
      tag: false,
      reason: 'the commit says [skip release]',
    };
  const last = newest(tags);
  if (!last)
    return { version: pkg.join('.'), tag: true, reason: 'first release' };
  if (compare(pkg, parse(last)) > 0)
    return {
      version: pkg.join('.'),
      tag: true,
      reason: `package.json was raised above ${last} by hand`,
    };
  const [major, minor, patch] = parse(last);
  const bump = bumpOf(messages);
  const next =
    bump === 'major'
      ? [major + 1, 0, 0]
      : bump === 'minor'
        ? [major, minor + 1, 0]
        : [major, minor, patch + 1];
  return {
    version: next.join('.'),
    tag: true,
    reason: `${bump} after ${last}`,
  };
}

if (require.main === module) {
  const git = (...args) =>
    execFileSync('git', args, { encoding: 'utf8' }).split('\n').filter(Boolean);
  const tags = git('tag', '--list', 'v*');
  const last = newest(tags);
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
