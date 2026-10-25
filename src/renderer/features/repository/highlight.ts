import { useEffect, useState } from 'react';
import type { HighlighterCore, ThemedToken } from 'shiki/core';
import type { CodeTheme } from '../../../shared/settings';

// Each setting is a light and dark Shiki theme; the app theme picks the half at render time.
export const THEME_PAIRS: Record<CodeTheme, { light: string; dark: string }> = {
  github: { light: 'github-light-default', dark: 'github-dark-default' },
  'github-high-contrast': {
    light: 'github-light-high-contrast',
    dark: 'github-dark-high-contrast',
  },
  one: { light: 'one-light', dark: 'one-dark-pro' },
  catppuccin: { light: 'catppuccin-latte', dark: 'catppuccin-mocha' },
  solarized: { light: 'solarized-light', dark: 'solarized-dark' },
  'rose-pine': { light: 'rose-pine-dawn', dark: 'rose-pine-moon' },
};

import { languageOf } from '../../../shared/file-types';

export { languageOf };

// The surfaces code sits on in each app theme, from globals.css. A token color must reach
// 4.5:1 on every one of them, changed-word tints included.
const BACKGROUNDS = {
  light: ['#ffffff', '#eaf6ee', '#fdeceb', '#c6e9d2', '#f7cdc9', '#f5f6f8'],
  dark: ['#131316', '#10241a', '#2b1615', '#1d4a2f', '#5a2522', '#0f1012'],
};

const channel = (value: number) => {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const rgb = (hex: string): [number, number, number] => {
  const h = hex.replace('#', '');
  const full =
    h.length === 3 ? [...h].map((c) => c + c).join('') : h.slice(0, 6);
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as [
    number,
    number,
    number,
  ];
};
const luminance = ([r, g, b]: [number, number, number]) =>
  0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
export const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(rgb(a)), luminance(rgb(b))].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
};

const fixed = new Map<string, string>();
// Moves a color toward ink (light theme) or white (dark theme) until it reads on every background.
export function readableColor(hex: string, mode: 'light' | 'dark'): string {
  if (!/^#[0-9a-f]{3,8}$/i.test(hex)) return hex;
  const key = `${mode}:${hex}`;
  const known = fixed.get(key);
  if (known) return known;
  const target: [number, number, number] =
    mode === 'light' ? [20, 22, 26] : [255, 255, 255];
  const start = rgb(hex);
  let result = hex;
  for (let step = 0; step <= 20; step++) {
    const t = step / 20;
    const mixed = start.map((c, i) => Math.round(c + (target[i]! - c) * t));
    const candidate = `#${mixed.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
    result = candidate;
    if (BACKGROUNDS[mode].every((bg) => contrast(candidate, bg) >= 4.5)) break;
  }
  fixed.set(key, result);
  return result;
}

export type CodeToken = {
  content: string;
  style: Record<string, string>;
};

let highlighter: Promise<HighlighterCore> | null = null;

// One long-lived highlighter, as Shiki recommends. The JavaScript regex engine needs no WASM,
// so the strict CSP stays as it is; themes and grammars load on first use, each its own chunk.
function getHighlighter(): Promise<HighlighterCore> {
  highlighter ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] =
      await Promise.all([
        import('shiki/core'),
        import('shiki/engine/javascript'),
      ]);
    return createHighlighterCore({
      themes: [],
      langs: [],
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    });
  })();
  return highlighter;
}

async function ensure(
  core: HighlighterCore,
  lang: string,
  theme: CodeTheme,
): Promise<boolean> {
  const [{ bundledLanguages }, { bundledThemes }] = await Promise.all([
    import('shiki/langs'),
    import('shiki/themes'),
  ]);
  const grammar = bundledLanguages[lang as keyof typeof bundledLanguages];
  if (!grammar) return false;
  if (!core.getLoadedLanguages().includes(lang))
    await core.loadLanguage(grammar);
  const pair = THEME_PAIRS[theme];
  for (const name of [pair.light, pair.dark])
    if (!core.getLoadedThemes().includes(name))
      await core.loadTheme(bundledThemes[name as keyof typeof bundledThemes]);
  return true;
}

const styleOf = (token: ThemedToken): Record<string, string> => {
  const html = token.htmlStyle ?? {};
  const style: Record<string, string> = {};
  if (html['--shiki-light'])
    style['--shiki-light'] = readableColor(html['--shiki-light'], 'light');
  if (html['--shiki-dark'])
    style['--shiki-dark'] = readableColor(html['--shiki-dark'], 'dark');
  if (html['--shiki-light-font-style'] === 'italic') style.fontStyle = 'italic';
  return style;
};

// Past this a diff renders as plain text; tokenizing it would cost more than it shows.
export const HIGHLIGHT_LIMIT = { lines: 4000, lineLength: 1000 };

// Tokenizes one block of consecutive lines, so comments and strings that span lines are right.
export async function tokenizeLines(
  lines: string[],
  lang: string,
  theme: CodeTheme,
): Promise<CodeToken[][] | null> {
  if (
    !lines.length ||
    lines.length > HIGHLIGHT_LIMIT.lines ||
    lines.some((line) => line.length > HIGHLIGHT_LIMIT.lineLength)
  )
    return null;
  const core = await getHighlighter();
  if (!(await ensure(core, lang, theme))) return null;
  const pair = THEME_PAIRS[theme];
  const { tokens } = core.codeToTokens(lines.join('\n'), {
    lang,
    themes: { light: pair.light, dark: pair.dark },
    defaultColor: false,
  });
  return lines.map((_line, index) =>
    (tokens[index] ?? []).map((token) => ({
      content: token.content,
      style: styleOf(token),
    })),
  );
}

// Tokens for each line of one block of text, such as one side of a conflict; null until ready,
// when Settings › Code turns syntax colors off, or for a language Shiki doesn't know.
export function useLineTokens(
  text: string | null,
  path: string,
  theme: CodeTheme,
  enabled: boolean,
): (CodeToken[] | null)[] | null {
  const [result, setResult] = useState<{
    text: string;
    tokens: CodeToken[][] | null;
  } | null>(null);
  useEffect(() => {
    if (!enabled || text === null) return;
    const lang = languageOf(path);
    if (!lang) return;
    let cancelled = false;
    void tokenizeLines(text.split('\n'), lang, theme)
      .then((tokens) => {
        if (!cancelled) setResult({ text, tokens });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [text, path, theme, enabled]);
  return enabled && result && result.text === text ? result.tokens : null;
}
