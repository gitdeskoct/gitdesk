import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  customGitBinary,
  gitBytes,
  versionAtLeast,
  type GitBytes,
} from './git-inspector';

type Expected = { branch: string | null; head: string | null; tree: string };
type Limits = { maxBytes: number; timeoutMs?: number };

export class ApprovedCommitChanged extends Error {}

const oid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const gitPath = (value: string) =>
  process.platform === 'win32' ? value.replaceAll('\\', '/') : value;

// These git-commit and auto-maintenance hooks take argv but no stdin. Only the
// reference hook needs its input replayed. Git itself resolves the original hooks,
// including relative core.hooksPath, worktrees and executable extensions on Windows.
const commitHooks = [
  'pre-commit',
  'prepare-commit-msg',
  'commit-msg',
  'post-commit',
  'post-index-change',
  'pre-auto-gc',
];

function transactionHook(expected: Expected, dir: string, git: string) {
  const zero = '0'.repeat(expected.tree.length);
  const old = expected.head ?? zero;
  const branch =
    expected.branch === null ? '' : `refs/heads/${expected.branch}`;
  const candidate = quote(`${dir}/.candidate`);
  return `if test "$1" = gitdesk-probe; then : > ${quote(`${dir}/.ready`)}; exit 0; fi
input=$(mktemp ${quote(`${dir}/input.XXXXXXXX`)}) || exit 1
trap 'rm -f -- "$input"' 0
cat > "$input" || exit 1
forward hook run --ignore-missing --to-stdin="$input" reference-transaction -- "$@" || exit $?
test "$1" = prepared || exit 0
reject() { : > ${quote(`${dir}/.changed`)}; exit 1; }
missing_ref() { ${git} show-ref --exists "$1" >/dev/null 2>&1; test "$?" = 2; }
# Newer Git cleans up AUTO_MERGE after publication, even when it does not exist.
if test -s ${candidate}; then
  test "$(cat "$input")" = ${quote(`${zero} ${zero} AUTO_MERGE`)} && missing_ref AUTO_MERGE || exit 1
  tip=$(${git} rev-parse --verify ${quote(branch || 'HEAD')}) && test "$tip" = "$(cat ${candidate})"
  exit $?
fi
missing_ref AUTO_MERGE || reject
status=0
sym=$(${git} symbolic-ref --quiet HEAD) || status=$?
test "$status:$sym" = ${quote(branch ? `0:${branch}` : '1:')} || reject
${expected.head ? `tip=$(${git} rev-parse --verify HEAD) && test "$tip" = ${quote(old)} || reject` : `missing_ref ${quote(branch)} || reject`}
seen_head= seen_branch= new=
while IFS=' ' read -r before after ref; do
  test "$before" = ${quote(old)} || reject
  case "$after" in ''|*[!0-9a-f]*) reject;; esac
  test "\${#after}" = ${expected.tree.length} || reject
  test -z "$new" || test "$new" = "$after" || reject
  new=$after
  case "$ref" in
    HEAD) test -z "$seen_head" || reject; seen_head=yes;;
    ${branch ? `${quote(branch)}) test -z "$seen_branch" || reject; seen_branch=yes;;` : ''}
    *) reject;;
  esac
done < "$input"
# Git 2.43 includes HEAD alongside the branch; newer Git reports the resolved ref alone.
test "${branch ? '$seen_branch' : '$seen_head'}" = yes || reject
kind=$(${git} --no-replace-objects cat-file -t "$new") || reject
test "$kind" = commit || reject
actual=$(${git} --no-replace-objects log -1 --no-notes --no-decorate --no-show-signature --format='%T:%P' "$new" --) || reject
test "$actual" = ${quote(`${expected.tree}:${expected.head ?? ''}`)} || reject
printf '%s\\n' "$new" > ${candidate}
`;
}

export async function runApprovedCommit(
  root: string,
  args: string[],
  expected: Expected,
  options: Limits,
  assertAllowed: () => void,
): Promise<GitBytes> {
  if (
    !oid.test(expected.tree) ||
    (expected.head !== null &&
      (!oid.test(expected.head) ||
        expected.head.length !== expected.tree.length)) ||
    (!expected.branch && !expected.head)
  )
    throw new Error('Git could not identify the approved commit.');
  const binary = customGitBinary();
  const git = quote(gitPath(binary ?? 'git'));
  const [version, config] = await Promise.all([
    gitBytes(root, ['--version'], { maxBytes: 1024 }),
    gitBytes(
      root,
      [
        'config',
        '--null',
        '--get-regexp',
        '^(hook\\.|extensions\\.refstorage$)',
      ],
      { maxBytes: 64 * 1024 },
    ),
  ]);
  const number = /^git version (\S+)/.exec(version.stdout.toString())?.[1];
  if (version.code !== 0 || !number || !versionAtLeast(number, '2.43.0'))
    throw new Error('Approved commits need Git 2.43 or newer.');
  if (
    (config.code !== 0 && config.code !== 1) ||
    config.stdout
      .toString()
      .split('\0')
      .some((line) => line && line !== 'extensions.refstorage\nfiles')
  )
    throw new Error(
      'Approved commits need file-based refs and file-based Git hooks.',
    );

  const dir = gitPath(await mkdtemp(path.resolve(tmpdir(), 'gitdesk-commit-')));
  const scoped = { ...options, privateHooksPath: dir };
  let remove = true;
  try {
    // The wrapper shell introduces variables absent from gitEnv. Also undo the
    // exec-path prefix which Git itself will prepend again when dispatching.
    const prelude = `#!/bin/sh\nunset GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0\nforward() { PATH=\${PATH#*:} /usr/bin/env -u PWD -u OLDPWD -u SHLVL -u _ ${git} "$@"; }\n`;
    for (const name of [...commitHooks, 'reference-transaction']) {
      const body =
        name === 'reference-transaction'
          ? transactionHook(expected, dir, git)
          : `forward hook run --ignore-missing ${name} -- "$@"\n`;
      await writeFile(path.join(dir, name), prelude + body, {
        mode: 0o700,
        flag: 'wx',
      });
    }
    // Git can silently ignore a non-executable hook (including a noexec temp dir).
    const probe = await gitBytes(
      root,
      ['hook', 'run', 'reference-transaction', '--', 'gitdesk-probe'],
      scoped,
    );
    if (probe.code !== 0 || !existsSync(path.join(dir, '.ready')))
      throw new Error('Git could not run the approved commit guard.');
    assertAllowed();
    if (customGitBinary() !== binary)
      throw new Error(
        'The selected Git executable changed before the approved commit.',
      );
    // On timeout gitBytes requests termination but the process can still be alive.
    // Never remove its guard until we know the command closed.
    remove = false;
    const result = await gitBytes(root, args, scoped);
    remove = true;
    if (result.code !== 0 && existsSync(path.join(dir, '.changed')))
      throw new ApprovedCommitChanged(
        'Git refused to publish a commit different from the approval.',
      );
    return result;
  } finally {
    if (remove)
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
