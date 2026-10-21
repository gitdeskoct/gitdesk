import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { UserError } from '../errors';
import { describeGitError, gitAt } from './git-inspector';

export type CloneProgress = { stage: string; percent: number };

export class CloneError extends UserError {}

// Clones into a hidden sibling folder and renames it into place only once Git succeeds, so a
// failed or cancelled clone never leaves a half-written repository under the real name. Only that
// temporary folder is ever deleted; an existing folder is refused, never touched.
export async function cloneInto(options: {
  url: string;
  parent: string;
  name: string;
  signal: AbortSignal;
  onProgress: (progress: CloneProgress) => void;
  // Transports Git may use for this clone; every other protocol, ext:: included, is refused.
  protocols?: string[];
}): Promise<string> {
  const target = path.join(options.parent, options.name);
  if (path.dirname(target) !== options.parent)
    throw new CloneError("That name can't be used as a folder.");
  if (existsSync(target))
    throw new CloneError(
      `A folder named ${options.name} already exists there.`,
    );

  const temp = path.join(
    options.parent,
    `.${options.name}.gitdesk-clone-${randomBytes(4).toString('hex')}`,
  );
  const protocols = options.protocols ?? ['https'];
  const git = gitAt(options.parent, {
    abort: options.signal,
    progress: ({ stage, progress }) =>
      options.onProgress({ stage, percent: progress }),
    config: [
      'protocol.allow=never',
      ...protocols.map((p) => `protocol.${p}.allow=always`),
    ],
    allowProtocolOverride: true,
  });
  try {
    await git.clone(options.url, temp, ['--no-recurse-submodules']);
    if (existsSync(target))
      throw new CloneError(
        `A folder named ${options.name} appeared there while cloning.`,
      );
    await rename(temp, target);
    return target;
  } catch (err) {
    await rm(temp, { recursive: true, force: true }).catch(() => undefined);
    if (options.signal.aborted)
      throw new CloneError('Clone cancelled. Nothing was left behind.');
    if (err instanceof UserError) throw err;
    const reason = describeGitError(err);
    throw new CloneError(
      reason === "Git couldn't read this repository."
        ? "Git couldn't clone that repository."
        : reason,
    );
  }
}
