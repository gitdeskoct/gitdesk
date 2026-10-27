const assert = require('node:assert/strict');
const { test } = require('node:test');
const { bumpOf, newest, nextVersion } = require('./next-version.cjs');

const base = {
  packageVersion: '1.0.0',
  tags: [],
  headTags: [],
  headMessage: 'Merge pull request #14',
  messages: [],
};

test('the first release is the package.json version', () => {
  assert.deepEqual(nextVersion(base), {
    version: '1.0.0',
    tag: true,
    reason: 'first release',
  });
});

test('later releases bump the patch number from the newest tag', () => {
  const result = nextVersion({
    ...base,
    tags: ['v1.0.0', 'v1.0.9', 'v1.0.10', 'not-a-version'],
    messages: ['Fix the diff view'],
  });
  assert.equal(result.version, '1.0.11');
  assert.equal(result.tag, true);
});

test('#minor, #major and BREAKING CHANGE bump more', () => {
  const tags = ['v1.4.2'];
  assert.equal(
    nextVersion({ ...base, tags, messages: ['Branches #minor'] }).version,
    '1.5.0',
  );
  assert.equal(
    nextVersion({ ...base, tags, messages: ['x', 'New store #major'] }).version,
    '2.0.0',
  );
  assert.equal(bumpOf(['Drop v1 API\n\nBREAKING CHANGE: gone']), 'major');
  assert.equal(bumpOf(['#minority report']), 'patch');
});

test('a package.json version raised by hand is released as it is', () => {
  const result = nextVersion({
    ...base,
    packageVersion: '2.0.0',
    tags: ['v1.3.0'],
  });
  assert.equal(result.version, '2.0.0');
  assert.equal(result.tag, true);
});

test('a package.json version at or below the newest tag is bumped from the tag', () => {
  assert.equal(
    nextVersion({ ...base, packageVersion: '1.0.0', tags: ['v1.2.0'] }).version,
    '1.2.1',
  );
});

test('a commit that is already tagged is that release again', () => {
  assert.deepEqual(
    nextVersion({ ...base, tags: ['v1.2.0'], headTags: ['v1.2.0'] }),
    { version: '1.2.0', tag: false, reason: 'this commit is already v1.2.0' },
  );
});

test('[skip release] in the newest commit releases nothing', () => {
  const result = nextVersion({
    ...base,
    tags: ['v1.2.0'],
    headMessage: 'Merge pull request #15\n\nTypo in README [skip release]',
  });
  assert.equal(result.version, null);
});

test('a package.json beta version is released as a prerelease', () => {
  assert.equal(
    nextVersion({
      ...base,
      packageVersion: '1.0.0-beta.1',
      tags: ['v1.0.0'],
    }).version,
    '1.0.0-beta.1',
  );
});

test('a package.json version outside semver is refused', () => {
  assert.throws(
    () => nextVersion({ ...base, packageVersion: '1.0' }),
    /isn't x\.y\.z or x\.y\.z-prerelease/,
  );
});

test('newest compares numerically, not as text', () => {
  assert.equal(newest(['v1.9.0', 'v1.10.0', 'v1.2.0']), 'v1.10.0');
  assert.equal(newest([]), null);
});
