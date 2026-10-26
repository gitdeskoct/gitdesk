import { describe, expect, it } from 'vitest';
import {
  buildPatch,
  newFilePatch,
  parsePatch,
  quotePath,
} from './patch-builder';

const DIFF = [
  'diff --git a/a.txt b/a.txt',
  'index 1111111..2222222 100644',
  '--- a/a.txt',
  '+++ b/a.txt',
  '@@ -1,3 +1,4 @@',
  ' one',
  '-two',
  '+TWO',
  '+extra',
  ' three',
  '',
].join('\n');

describe('patch builder', () => {
  it('returns Git’s own patch when everything is selected', () => {
    const patch = parsePatch(DIFF)!;
    expect(buildPatch(patch, [{ index: 0 }], false)).toEqual({ patch: DIFF });
  });

  it('turns an unselected removal into context and drops an unselected addition, forward', () => {
    const patch = parsePatch(DIFF)!;
    // Lines: 0 " one", 1 "-two", 2 "+TWO", 3 "+extra", 4 " three". Stage only "+extra".
    const built = buildPatch(patch, [{ index: 0, lines: [3] }], false);
    expect(built).toEqual({
      patch: [
        'diff --git a/a.txt b/a.txt',
        '--- a/a.txt',
        '+++ b/a.txt',
        '@@ -1,3 +1,4 @@',
        ' one',
        ' two',
        '+extra',
        ' three',
        '',
      ].join('\n'),
    });
  });

  it('keeps unselected additions as context when reversed, so the post-image matches', () => {
    const patch = parsePatch(DIFF)!;
    // Unstage only the removal of "two": "+TWO" and "+extra" stay in the index.
    const built = buildPatch(patch, [{ index: 0, lines: [1] }], true);
    expect(built).toEqual({
      patch: [
        'diff --git a/a.txt b/a.txt',
        '--- a/a.txt',
        '+++ b/a.txt',
        '@@ -1,5 +1,4 @@',
        ' one',
        '-two',
        ' TWO',
        ' extra',
        ' three',
        '',
      ].join('\n'),
    });
  });

  it('keeps the no-newline marker with its line and CR bytes as they were', () => {
    const text = [
      'diff --git a/w.txt b/w.txt',
      '--- a/w.txt',
      '+++ b/w.txt',
      '@@ -1 +1,2 @@',
      ' a\r',
      '+b',
      '\\ No newline at end of file',
      '',
    ].join('\n');
    const patch = parsePatch(text)!;
    expect(patch.hunks[0]!.lines[1]).toEqual({
      op: '+',
      text: 'b',
      noEol: true,
    });
    expect(buildPatch(patch, [{ index: 0, lines: [1] }], false)).toEqual({
      patch: text,
    });
  });

  it('refuses partial patches that would mean something else', () => {
    const renamed = parsePatch(
      [
        'diff --git a/old.txt b/new.txt',
        'similarity index 80%',
        'rename from old.txt',
        'rename to new.txt',
        '--- a/old.txt',
        '+++ b/new.txt',
        '@@ -1,2 +1,2 @@',
        '-x',
        '+y',
        ' z',
        '',
      ].join('\n'),
    )!;
    expect(buildPatch(renamed, [{ index: 0, lines: [0] }], false)).toEqual({
      refused: 'renamed',
    });
    const added = parsePatch(newFilePatch('n.txt', 'a\nb\n', '100644'))!;
    expect(buildPatch(added, [{ index: 0, lines: [0] }], true)).toEqual({
      refused: 'new-file',
    });
    expect(
      buildPatch(parsePatch(DIFF)!, [{ index: 0, lines: [0] }], false),
    ).toEqual({
      refused: 'empty',
    });
  });

  it('makes a partial deletion a plain edit that leaves the file', () => {
    const text = [
      'diff --git a/d.txt b/d.txt',
      'deleted file mode 100644',
      'index 1111111..0000000',
      '--- a/d.txt',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-keep',
      '-drop',
      '',
    ].join('\n');
    const built = buildPatch(
      parsePatch(text)!,
      [{ index: 0, lines: [1] }],
      false,
    );
    expect(built).toEqual({
      patch: [
        'diff --git a/d.txt b/d.txt',
        '--- a/d.txt',
        '+++ b/d.txt',
        '@@ -1,2 +1,1 @@',
        ' keep',
        '-drop',
        '',
      ].join('\n'),
    });
  });

  it('writes a new file patch with quoted names and the missing newline', () => {
    expect(quotePath('plain name.txt')).toBe('plain name.txt');
    expect(quotePath('tab\there')).toBe('"tab\\there"');
    expect(newFilePatch('a"b.txt', 'x', '100644')).toBe(
      [
        'diff --git "a/a\\"b.txt" "b/a\\"b.txt"',
        'new file mode 100644',
        '--- /dev/null',
        '+++ "b/a\\"b.txt"',
        '@@ -0,0 +1,1 @@',
        '+x',
        '\\ No newline at end of file',
        '',
      ].join('\n'),
    );
  });
});
