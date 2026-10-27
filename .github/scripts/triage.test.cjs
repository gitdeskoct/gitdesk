const assert = require('node:assert/strict');
const { test } = require('node:test');
const config = require('../triage.json');
const triage = require('./triage.cjs');

const form = (steps) =>
  `### Operating system\n\nWindows\n\n### Steps to reproduce\n\n${steps}\n\n### What happened\n\nIt froze.`;

test('labels by whole words, not substrings', () => {
  assert.deepEqual(
    triage.classify('Updater fails on Windows', '', [], config).sort(),
    ['updater', 'windows'],
  );
  assert.deepEqual(
    triage.classify('The list updated twice', 'nothing else', [], config),
    [],
  );
});

test('a bug without steps needs reproduction', () => {
  assert.ok(
    triage
      .classify('Crash', form('_No response_'), ['bug'], config)
      .includes('needs-reproduction'),
  );
  assert.ok(
    !triage
      .classify('Crash', form('1. Open a repository'), ['bug'], config)
      .includes('needs-reproduction'),
  );
});

test('a bug is never also labelled a question', () => {
  assert.ok(
    !triage
      .classify('How do I stop the crash', '', ['bug'], config)
      .includes('question'),
  );
});

test('assignees follow the first matching label, then the default', () => {
  const people = { security: ['sec'], updater: ['upd'], default: ['all'] };
  assert.deepEqual(
    triage.chooseAssignees(['updater', 'security'], { assignees: people }),
    ['sec'],
  );
  assert.deepEqual(triage.chooseAssignees(['linux'], { assignees: people }), [
    'all',
  ]);
});

test('finds a reworded duplicate and ignores unrelated issues', () => {
  const issue = {
    number: 9,
    title: 'App fails to update on Windows',
    body: 'Error: sha512 checksum mismatch at C:\\Users\\me\\AppData\\x.exe',
  };
  const candidates = [
    {
      number: 3,
      state: 'open',
      title: 'Update fails on Windows',
      body: 'error: sha512 checksum mismatch (12 bytes)',
    },
    { number: 4, state: 'open', title: 'Dark theme colors', body: '' },
    { number: 5, state: 'open', title: 'PR', pull_request: {}, body: '' },
    { number: 9, state: 'open', title: issue.title, body: issue.body },
  ];
  const found = triage.findDuplicates(issue, candidates, config.duplicates);
  assert.deepEqual(
    found.map((other) => other.number),
    [3],
  );
});

test('the comment names issue numbers only and carries the marker', () => {
  const body = triage.duplicateComment([
    { number: 3, state: 'open', title: '@everyone **look**' },
  ]);
  assert.ok(body.startsWith(triage.MARKER));
  assert.ok(body.includes('#3 (open)'));
  assert.ok(!body.includes('@everyone'));
});

test('main labels, assigns and comments once on a new issue', async () => {
  const calls = [];
  const rest = new Proxy(
    {},
    {
      get: (_, name) => async (args) => {
        calls.push([name, args]);
        return { data: [] };
      },
    },
  );
  const lists = {
    listLabelsForRepo: [{ name: 'bug' }],
    listComments: [],
    listForRepo: [
      { number: 3, state: 'open', title: 'Update fails on Windows', body: '' },
    ],
  };
  const github = {
    rest: { issues: rest },
    // Routed by the arguments each list call passes.
    paginate: async (_method, args) => {
      if (args.issue_number) return lists.listComments;
      if (args.state) return args.state === 'open' ? lists.listForRepo : [];
      return lists.listLabelsForRepo;
    },
  };
  await triage.main({
    github,
    core: { info() {} },
    config,
    context: {
      repo: { owner: 'o', repo: 'r' },
      payload: {
        action: 'opened',
        issue: {
          number: 9,
          title: 'App fails to update on Windows',
          body: '',
          labels: [{ name: 'bug' }],
          assignees: [],
        },
      },
    },
  });
  const names = calls.map(([name]) => name);
  assert.ok(names.includes('createLabel'));
  assert.ok(!calls.some(([n, a]) => n === 'createLabel' && a.name === 'bug'));
  const labelled = calls.find(([n]) => n === 'addLabels')[1].labels;
  assert.deepEqual(labelled.sort(), [
    'needs-reproduction',
    'updater',
    'windows',
  ]);
  assert.deepEqual(calls.find(([n]) => n === 'addAssignees')[1].assignees, [
    'BotCoder254',
  ]);
  assert.equal(names.filter((n) => n === 'createComment').length, 1);
});
