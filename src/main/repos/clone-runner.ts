import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { UserError } from '../errors';
import { describeGitError, gitAt } from './git-inspector';

export type CloneProgress = {
  stage: string;
  percent: number;
  receivedBytes: number | null;
  bytesPerSecond: number | null;
};

export class CloneError extends UserError {}

const UNITS: Record<string, number> = {
  B: 1,
  bytes: 1,
  KiB: 1024,
  MiB: 1024 ** 2,
  GiB: 1024 ** 3,
};

// One line of `git clone --progress`, e.g.
// "Receiving objects:  45% (450/1000), 1.20 MiB | 2.40 MiB/s". Git rewrites the line in place
// with \r, so callers split on both \r and \n. Only the receiving stage carries size and speed.
const LINE =
  /^(?:remote: )?([A-Za-z][A-Za-z ]+):\s+(\d{1,3})% \(\d+\/\d+\)(?:,\s*([\d.]+)\s*(B|bytes|KiB|MiB|GiB)(?:\s*\|\s*([\d.]+)\s*(B|bytes|KiB|MiB|GiB)\/s)?)?/;

export function parseGitProgress(line: string): CloneProgress | null {
  const match = LINE.exec(line.trim());
  if (!match) return null;
  const [, stage, percent, size, sizeUnit, rate, rateUnit] = match;
  const bytes = (value?: string, unit?: string) =>
    value && unit ? Math.round(Number(value) * UNITS[unit]!) : null;
  return {
    stage: stage!.trim(),
    percent: Math.min(100, Number(percent)),
    receivedBytes: bytes(size, sizeUnit),
    bytesPerSecond: bytes(rate, rateUnit),
  };
}

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
    config: [
      'protocol.allow=never',
      ...protocols.map((p) => `protocol.${p}.allow=always`),
    ],
    allowProtocolOverride: true,
  });
  // The last size and speed seen survive into later stages (resolving deltas reports neither).
  let last: CloneProgress | null = null;
  git.outputHandler((_command, _stdout, stderr) => {
    let pending = '';
    stderr.on('data', (chunk: Buffer) => {
      const lines = (pending + chunk.toString('utf8')).split(/[\r\n]/);
      pending = lines.pop() ?? '';
      for (const line of lines) {
        const parsed = parseGitProgress(line);
        if (!parsed) continue;
        last = {
          ...parsed,
          receivedBytes: parsed.receivedBytes ?? last?.receivedBytes ?? null,
          bytesPerSecond:
            parsed.receivedBytes !== null ? parsed.bytesPerSecond : null,
        };
        options.onProgress(last);
      }
    });
  });
  try {
    await git.clone(options.url, temp, [
      '--progress',
      '--no-recurse-submodules',
    ]);
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
