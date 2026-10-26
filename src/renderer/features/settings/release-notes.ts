export type NoteBlock =
  | { kind: 'heading'; text: string }
  | { kind: 'list'; items: string[] }
  | { kind: 'text'; text: string };

// GitHub sends release notes as HTML written by whoever published the release. It is parsed in an
// inert document (no scripts run, no images load) and only its text comes out, as headings, lists
// and paragraphs. Nothing is ever inserted as HTML, so links, images and styles can't reach the page.
export function noteBlocks(html: string, limit = 40): NoteBlock[] {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  // Their text is code or markup, not notes.
  for (const node of doc.querySelectorAll(
    'script, style, template, noscript, iframe, object, svg',
  ))
    node.remove();
  const blocks: NoteBlock[] = [];
  const clean = (text: string | null) =>
    (text ?? '').replace(/\s+/g, ' ').trim();
  const walk = (parent: Element) => {
    for (const node of Array.from(parent.children)) {
      if (blocks.length >= limit) return;
      const tag = node.tagName.toLowerCase();
      if (/^h[1-6]$/.test(tag)) {
        const text = clean(node.textContent);
        if (text) blocks.push({ kind: 'heading', text });
      } else if (tag === 'ul' || tag === 'ol') {
        const items = Array.from(node.querySelectorAll(':scope > li'))
          .map((li) => clean(li.textContent))
          .filter(Boolean);
        if (items.length) blocks.push({ kind: 'list', items });
      } else if (tag === 'div' || tag === 'section' || tag === 'article') {
        walk(node);
      } else {
        const text = clean(node.textContent);
        if (text) blocks.push({ kind: 'text', text });
      }
    }
  };
  walk(doc.body);
  // Notes written as plain text have no elements to walk.
  if (!blocks.length && clean(doc.body.textContent))
    blocks.push({ kind: 'text', text: clean(doc.body.textContent) });
  return blocks;
}
