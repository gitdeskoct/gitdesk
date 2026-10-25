import { describe, expect, it } from 'vitest';
import { classify, imageMime } from './source-classify';

describe('classify', () => {
  it('reads UTF-8 text and reports line endings', () => {
    expect(classify(Buffer.from('a\nb\n'), 'a.ts', null, 10)).toMatchObject({
      kind: 'text',
      text: 'a\nb\n',
      eol: 'lf',
    });
    expect(classify(Buffer.from('a\r\nb\r\n'), 'a.ts', null, 10)).toMatchObject(
      {
        text: 'a\nb\n',
        eol: 'crlf',
      },
    );
    expect(classify(Buffer.from('a\r\nb\n'), 'a.ts', null, 10)).toMatchObject({
      eol: 'mixed',
    });
    expect(classify(Buffer.from('é ü 字'), 'a.txt', null, 10)).toMatchObject({
      text: 'é ü 字',
    });
  });

  it('calls NUL bytes and invalid UTF-8 binary instead of showing them garbled', () => {
    expect(classify(Buffer.from([1, 0, 2]), 'a.ts', null, 10)).toMatchObject({
      kind: 'binary',
      reason: 'binary',
    });
    expect(
      classify(Buffer.from([0x63, 0xe9]), 'a.txt', null, 10),
    ).toMatchObject({
      kind: 'binary',
      reason: 'encoding',
    });
  });

  it('turns small images into data URLs and leaves big ones to the size checks', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    expect(classify(png, 'logo.PNG', null, 10)).toEqual({
      kind: 'image',
      mime: 'image/png',
      size: 4,
      dataUrl: 'data:image/png;base64,iVBORw==',
    });
    expect(classify(png, 'logo.png', null, 2).kind).toBe('binary');
    expect(imageMime('icon.svg')).toBe('image/svg+xml');
    expect(imageMime('archive.tar.gz')).toBeNull();
  });
});
