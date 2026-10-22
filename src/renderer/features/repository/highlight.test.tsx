import { describe, expect, it } from 'vitest';
import {
  contrast,
  languageOf,
  readableColor,
  tokenizeLines,
} from './highlight';
import { changedRanges, wordRanges } from './word-diff';

const LIGHT_BACKGROUNDS = [
  '#ffffff',
  '#eaf6ee',
  '#fdeceb',
  '#c6e9d2',
  '#f7cdc9',
  '#f5f6f8',
];

describe('highlight', () => {
  it('picks a grammar from the file name', () => {
    expect(languageOf('src/app.tsx')).toBe('tsx');
    expect(languageOf('Dockerfile')).toBe('dockerfile');
    expect(languageOf('notes.unknown')).toBeNull();
  });

  it('lifts any token color to 4.5:1 on every diff background', () => {
    const fixed = readableColor('#a0a1a7', 'light');
    for (const bg of LIGHT_BACKGROUNDS)
      expect(contrast(fixed, bg)).toBeGreaterThanOrEqual(4.5);
    expect(readableColor('#1f2328', 'light')).toBe('#1f2328');
  });

  it('tokenizes a multi-line block with both theme colors per token', async () => {
    const lines = await tokenizeLines(
      ['/* one', 'two */', "const a = 'x';"],
      'typescript',
      'github',
    );
    expect(lines).toHaveLength(3);
    const comment = lines![1]![0]!;
    expect(comment.content).toBe('two */');
    expect(comment.style['--shiki-light']).toMatch(/^#/);
    expect(comment.style['--shiki-dark']).toMatch(/^#/);
  }, 20_000);
});

describe('word diff', () => {
  it('marks only the words that changed', () => {
    const [del, add] = changedRanges('const a = 1;', 'const a = 2;');
    expect('const a = 1;'.slice(...del[0]!)).toBe('1');
    expect('const a = 2;'.slice(...add[0]!)).toBe('2');
  });

  it('pairs removed lines with the added lines after them', () => {
    const ranges = wordRanges([
      { kind: 'del', old: 1, new: null, text: 'return status;' },
      { kind: 'add', old: null, new: 1, text: 'return status ?? null;' },
    ]);
    expect(ranges.get(1)).toBeDefined();
  });
});
