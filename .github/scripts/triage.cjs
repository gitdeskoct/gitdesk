// Labels, assigns and flags probable duplicates for new issues. Run by issue-triage.yml through
// actions/github-script. Issue text is only ever data here: it is matched, never evaluated.

const MARKER = '<!-- gitdesk-triage:duplicates -->';

const STOPWORDS = new Set(
  (
    'a an and are as at be but by can cant could did does doesnt dont for from has have i if in ' +
    'is it its me my no not of on or so that the then there this to was wasnt when where which ' +
    'while why will with wont you your after before again also any just still when gitdesk app ' +
    'bug issue problem error please help broken work works working doesn'
  ).split(' '),
);

// A keyword matches as a whole word or phrase, so "update" never matches "updated by".
function hasKeyword(text, keyword) {
  const escaped = keyword.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`).test(text);
}

function classify(title, body, existing, config) {
  const text = `${title}\n${body}`.toLowerCase();
  const labels = new Set();
  for (const rule of config.rules) {
    if (rule.label === 'question' && existing.includes('bug')) continue;
    if (rule.any.some((keyword) => hasKeyword(text, keyword)))
      labels.add(rule.label);
  }
  if (existing.includes('bug') && !hasSteps(body))
    labels.add('needs-reproduction');
  return [...labels];
}

// Issue forms write "### Steps to reproduce" followed by the answer, or "_No response_".
function hasSteps(body) {
  const match =
    /^###\s*steps to reproduce\s*$([\s\S]*?)(?=^###\s|(?![\s\S]))/im.exec(body);
  if (!match) return false;
  const answer = match[1].trim();
  return answer.length > 0 && answer !== '_No response_';
}

// The first matching label in config order wins; "default" covers everything else.
function chooseAssignees(labels, config) {
  for (const [label, people] of Object.entries(config.assignees)) {
    if (label !== 'default' && labels.includes(label)) return people;
  }
  return config.assignees.default ?? [];
}

function stem(word) {
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith('ed')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss'))
    return word.slice(0, -1);
  return word;
}

function tokens(text) {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(' ')
      .filter((word) => word.length > 1 && !STOPWORDS.has(word))
      .map(stem),
  );
}

// The first line that reads like an error, with numbers, hashes and paths taken out.
function errorSignature(body) {
  const line = (body ?? '')
    .split('\n')
    .map((value) => value.trim())
    .find(
      (value) =>
        !value.startsWith('#') &&
        /\b(error|exception|failed|cannot|err_[a-z_]+)\b/i.test(value),
    );
  if (!line) return null;
  return tokens(
    line
      .replace(/(?:[a-z]:)?[\\/][^\s'"]+/gi, ' ')
      .replace(/\b[0-9a-f]{7,}\b/gi, ' ')
      .replace(/\d+/g, ' '),
  );
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  return shared / (a.size + b.size - shared);
}

function similarity(a, b) {
  const title = jaccard(tokens(a.title), tokens(b.title));
  const errorA = errorSignature(a.body);
  const errorB = errorSignature(b.body);
  if (!errorA || !errorB) return title;
  return 0.6 * title + 0.4 * jaccard(errorA, errorB);
}

function findDuplicates(issue, candidates, options) {
  return candidates
    .filter((other) => other.number !== issue.number && !other.pull_request)
    .map((other) => ({ other, score: similarity(issue, other) }))
    .filter(({ score }) => score >= options.threshold)
    .sort((x, y) => y.score - x.score)
    .slice(0, options.maxListed)
    .map(({ other }) => other);
}

// Numbers only, never titles: a title could carry markdown or @mentions into the bot's comment.
function duplicateComment(matches) {
  const list = matches
    .map((other) => `- #${other.number} (${other.state})`)
    .join('\n');
  return [
    MARKER,
    'This looks like it may be the same problem as:',
    '',
    list,
    '',
    'A person will check before anything is closed. If yours is different, say what differs and remove the `possible-duplicate` label.',
  ].join('\n');
}

async function listCandidates(github, owner, repo, options) {
  const collect = async (params) => {
    let seen = 0;
    return github.paginate(
      github.rest.issues.listForRepo,
      { owner, repo, per_page: 100, ...params },
      (response, done) => {
        seen += response.data.length;
        if (seen >= options.maxCandidates) done();
        return response.data;
      },
    );
  };
  const since = new Date(
    Date.now() - options.closedWithinDays * 86_400_000,
  ).toISOString();
  const open = await collect({ state: 'open' });
  const closed = await collect({ state: 'closed', since });
  return [...open, ...closed];
}

async function ensureLabels(github, owner, repo, labels) {
  const existing = new Set(
    (
      await github.paginate(github.rest.issues.listLabelsForRepo, {
        owner,
        repo,
        per_page: 100,
      })
    ).map((label) => label.name),
  );
  for (const [name, { color, description }] of Object.entries(labels)) {
    if (!existing.has(name))
      await github.rest.issues.createLabel({
        owner,
        repo,
        name,
        color,
        description,
      });
  }
}

async function main({ github, context, core, config }) {
  const issue = context.payload.issue;
  if (!issue || issue.pull_request) return;
  const { owner, repo } = context.repo;
  const issue_number = issue.number;
  const opened = context.payload.action === 'opened';
  await ensureLabels(github, owner, repo, config.labels);

  // Labels and owners are set once, when the issue opens, so a later edit never undoes a person's change.
  if (opened) {
    const existing = issue.labels.map((label) =>
      typeof label === 'string' ? label : label.name,
    );
    const added = classify(
      issue.title,
      issue.body ?? '',
      existing,
      config,
    ).filter((label) => !existing.includes(label));
    if (added.length)
      await github.rest.issues.addLabels({
        owner,
        repo,
        issue_number,
        labels: added,
      });
    if (!issue.assignees?.length) {
      const people = chooseAssignees([...existing, ...added], config);
      if (people.length)
        await github.rest.issues.addAssignees({
          owner,
          repo,
          issue_number,
          assignees: people,
        });
    }
    core.info(`Labels added: ${added.join(', ') || 'none'}`);
  }

  const comments = await github.paginate(github.rest.issues.listComments, {
    owner,
    repo,
    issue_number,
    per_page: 100,
  });
  if (comments.some((comment) => comment.body?.includes(MARKER))) return;
  const candidates = await listCandidates(
    github,
    owner,
    repo,
    config.duplicates,
  );
  const matches = findDuplicates(issue, candidates, config.duplicates);
  if (!matches.length) return;
  await github.rest.issues.addLabels({
    owner,
    repo,
    issue_number,
    labels: ['possible-duplicate'],
  });
  await github.rest.issues.createComment({
    owner,
    repo,
    issue_number,
    body: duplicateComment(matches),
  });
  core.info(`Possible duplicates: ${matches.map((m) => m.number).join(', ')}`);
}

module.exports = {
  MARKER,
  classify,
  hasSteps,
  chooseAssignees,
  tokens,
  errorSignature,
  similarity,
  findDuplicates,
  duplicateComment,
  main,
};
