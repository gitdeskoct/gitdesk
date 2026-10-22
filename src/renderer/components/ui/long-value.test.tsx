import { describe, expect, it } from 'vitest';
import { splitTail } from './long-value';

describe('splitTail', () => {
  it('keeps the last segment of a path or URL whole', () => {
    expect(splitTail('~/Projects/gitdesk')).toEqual({
      head: '~/Projects',
      tail: '/gitdesk',
    });
    expect(splitTail('C:\\Users\\me\\app')).toEqual({
      head: 'C:\\Users\\me',
      tail: '\\app',
    });
    expect(
      splitTail('https://a.artifacts.cloudflare.net/git/gitdesk/0f.git'),
    ).toEqual({
      head: 'https://a.artifacts.cloudflare.net/git/gitdesk',
      tail: '/0f.git',
    });
  });

  it('ignores a trailing separator and leaves short values alone', () => {
    expect(splitTail('~/src/')).toEqual({ head: '~', tail: '/src/' });
    expect(splitTail('gitdesk')).toEqual({ head: '', tail: 'gitdesk' });
    expect(splitTail('/srv')).toEqual({ head: '', tail: '/srv' });
  });
});
