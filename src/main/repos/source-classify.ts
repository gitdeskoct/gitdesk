import type { SourceFile } from '../../shared/source';

// Only formats Chromium draws in an <img>. SVG goes through <img> too, where its scripts never run.
const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
};

export function imageMime(path: string): string | null {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
  return IMAGE_MIME[ext] ?? null;
}

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

// Decides how bytes are shown. A NUL in the first 8000 bytes means binary, as Git decides;
// text that isn't valid UTF-8 is called binary too rather than shown garbled.
export function classify(
  bytes: Buffer,
  path: string,
  oid: string | null,
  imageLimit: number,
): SourceFile {
  const mime = imageMime(path);
  if (mime && bytes.length <= imageLimit)
    return {
      kind: 'image',
      mime,
      size: bytes.length,
      dataUrl: `data:${mime};base64,${bytes.toString('base64')}`,
    };
  if (bytes.subarray(0, 8000).includes(0))
    return { kind: 'binary', size: bytes.length, reason: 'binary' };
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    return { kind: 'binary', size: bytes.length, reason: 'encoding' };
  }
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  return {
    kind: 'text',
    text: crlf ? text.replace(/\r\n/g, '\n') : text,
    size: bytes.length,
    oid,
    eol: crlf && lf ? 'mixed' : crlf ? 'crlf' : lf ? 'lf' : 'none',
  };
}
