import * as RadioGroup from '@radix-ui/react-radio-group';
import { Check } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  CODE_THEMES,
  type CodeTheme,
  type Settings,
} from '../../../shared/settings';
import { Segmented } from '../../components/ui/segmented';
import { SettingGroup, SettingRow } from '../../components/ui/setting-row';
import { Switch } from '../../components/ui/switch';
import { TextField } from '../../components/ui/text-field';
import { cn } from '../../lib/cn';
import { useSettings, useUpdateSettings } from '../../lib/queries';
import { tokenizeLines, type CodeToken } from '../repository/highlight';
import { PageTitle } from '../shell/page';

const THEME_NAMES: Record<CodeTheme, string> = {
  github: 'GitHub',
  'github-high-contrast': 'GitHub high contrast',
  one: 'One',
  catppuccin: 'Catppuccin',
  solarized: 'Solarized',
  'rose-pine': 'Rosé Pine',
};

const SAMPLE = [
  "const files = await status('main');",
  '// Changed since the last commit',
  'return files.length > 0;',
];

// Previews show both fixed palettes, so the two surfaces are literal values on purpose.
const SURFACE = { light: '#ffffff', dark: '#131316' };

function useSampleTokens(theme: CodeTheme): CodeToken[][] | null {
  const [tokens, setTokens] = useState<CodeToken[][] | null>(null);
  useEffect(() => {
    let cancelled = false;
    void tokenizeLines(SAMPLE, 'typescript', theme)
      .then((result) => !cancelled && setTokens(result))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [theme]);
  return tokens;
}

function Half({
  tokens,
  mode,
}: {
  tokens: CodeToken[][] | null;
  mode: 'light' | 'dark';
}) {
  return (
    <span
      className="grid min-w-0 flex-1 content-center gap-1 overflow-hidden p-2.5 font-mono text-[0.625rem] leading-[0.875rem] whitespace-pre"
      style={{
        background: SURFACE[mode],
        color: mode === 'light' ? '#14161a' : '#f1f1f3',
      }}
    >
      {(
        tokens ??
        SAMPLE.map((line): CodeToken[] => [{ content: line, style: {} }])
      ).map((line, i) => (
        <span key={i} className="truncate">
          {line.map((token, j) => (
            <span
              key={j}
              style={{
                color:
                  token.style[
                    mode === 'light' ? '--shiki-light' : '--shiki-dark'
                  ],
              }}
            >
              {token.content}
            </span>
          ))}
        </span>
      ))}
    </span>
  );
}

function ThemeCard({ theme }: { theme: CodeTheme }) {
  const tokens = useSampleTokens(theme);
  return (
    <RadioGroup.Item
      value={theme}
      className="group grid gap-2.5 rounded-sm text-left text-[0.8125rem] text-muted focus-visible:outline-offset-4"
    >
      {/* The preview is the one place a frame earns its keep: it shows the colors being chosen. */}
      <span className="flex aspect-[16/10] overflow-hidden rounded-sm shadow-[0_0_0_1px_var(--line)] transition-shadow group-hover:shadow-[0_0_0_1px_var(--line-strong)] group-data-[state=checked]:shadow-[0_0_0_2px_var(--accent)]">
        <Half tokens={tokens} mode="light" />
        <Half tokens={tokens} mode="dark" />
      </span>
      <span className="flex items-center justify-between group-data-[state=checked]:font-semibold group-data-[state=checked]:text-ink">
        {THEME_NAMES[theme]}
        <Check
          aria-hidden
          className="size-4 text-accent opacity-0 group-data-[state=checked]:opacity-100"
        />
      </span>
    </RadioGroup.Item>
  );
}

function Preview({ settings }: { settings: Settings }) {
  const tokens = useSampleTokens(settings.codeTheme);
  const rows = [
    { kind: 'del' as const, line: 1, text: SAMPLE[0]!, tokens: tokens?.[0] },
    { kind: 'add' as const, line: 1, text: SAMPLE[2]!, tokens: tokens?.[2] },
  ];
  return (
    <div
      className="code-text overflow-hidden rounded-sm border border-line"
      aria-label="Preview of the current code settings"
      role="img"
    >
      <div className="bg-diff-hunk px-3 text-muted">@@ -1,1 +1,1 @@</div>
      {rows.map((row) => (
        <div
          key={row.kind}
          className={cn(
            'grid grid-cols-[2.5rem_1.25rem_minmax(0,1fr)]',
            row.kind === 'add' ? 'bg-diff-add' : 'bg-diff-del',
          )}
        >
          <span className="pr-2 text-right text-muted">{row.line}</span>
          <span className="font-semibold text-ink">
            {row.kind === 'add' ? '+' : '−'}
          </span>
          <span
            className={cn(
              'pr-3',
              settings.diffWrap
                ? 'whitespace-pre-wrap'
                : 'truncate whitespace-pre',
            )}
          >
            {settings.diffSyntax && row.tokens
              ? row.tokens.map((token, i) => (
                  <span key={i} className="code-token" style={token.style}>
                    {token.content}
                  </span>
                ))
              : row.text}
          </span>
        </div>
      ))}
    </div>
  );
}

const FONT = /^[A-Za-z0-9 _-]*$/;

export function CodeSection() {
  const { data: settings } = useSettings();
  const update = useUpdateSettings();
  const [font, setFont] = useState('');
  useEffect(() => setFont(settings?.codeFont ?? ''), [settings?.codeFont]);
  if (!settings) return null;
  const fontError = FONT.test(font)
    ? undefined
    : 'Use the font name only: letters, numbers, spaces and dashes.';
  const saveFont = () => {
    if (!fontError && font.trim() !== settings.codeFont)
      update.mutate({ codeFont: font.trim() });
  };

  return (
    <>
      <PageTitle title="Code">
        How diffs and code look in gitdesk. Your editor's own settings are not
        touched.
      </PageTitle>
      <SettingGroup>
        <SettingRow
          id="code-theme"
          label="Syntax theme"
          description="Each theme has a light and a dark half; gitdesk uses the one that matches its own theme. Any color under 4.5:1 on gitdesk's backgrounds is darkened or lightened until it reads."
          stacked
        >
          <RadioGroup.Root
            aria-label="Syntax theme"
            value={settings.codeTheme}
            onValueChange={(codeTheme) =>
              update.mutate({ codeTheme: codeTheme as CodeTheme })
            }
            orientation="horizontal"
            className="grid grid-cols-2 gap-4 pt-1 min-[900px]:grid-cols-3"
          >
            {CODE_THEMES.map((theme) => (
              <ThemeCard key={theme} theme={theme} />
            ))}
          </RadioGroup.Root>
        </SettingRow>
        <SettingRow
          id="code-font"
          label="Code font"
          description="Any font installed on this computer. Empty uses the system monospace font."
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              saveFont();
            }}
          >
            <TextField
              label="Code font"
              hideLabel
              className="w-52"
              value={font}
              onChange={(event) => setFont(event.target.value)}
              onBlur={saveFont}
              error={fontError}
              placeholder="Cascadia Code"
              maxLength={80}
              spellCheck={false}
            />
          </form>
        </SettingRow>
        <SettingRow
          id="code-size"
          label="Code size"
          description="Diffs, file paths and hashes."
        >
          <Segmented
            label="Code size"
            value={String(settings.codeSize)}
            onChange={(next) =>
              update.mutate({ codeSize: Number(next) as Settings['codeSize'] })
            }
            options={['12', '13', '14', '15'].map((value) => ({
              value,
              label: value,
            }))}
          />
        </SettingRow>
        <SettingRow
          id="code-line-height"
          label="Line height"
          description="Space between diff lines."
        >
          <Segmented
            label="Line height"
            value={settings.codeLineHeight}
            onChange={(codeLineHeight) => update.mutate({ codeLineHeight })}
            options={[
              { value: 'compact', label: 'Compact' },
              { value: 'default', label: 'Default' },
              { value: 'relaxed', label: 'Relaxed' },
            ]}
          />
        </SettingRow>
        <SettingRow
          id="code-tab-width"
          label="Tab width"
          description="How wide a tab character is drawn."
        >
          <Segmented
            label="Tab width"
            value={String(settings.codeTabWidth)}
            onChange={(next) =>
              update.mutate({
                codeTabWidth: Number(next) as Settings['codeTabWidth'],
              })
            }
            options={['2', '4', '8'].map((value) => ({ value, label: value }))}
          />
        </SettingRow>
        <SettingRow
          id="code-ligatures"
          label="Font ligatures"
          description="Joins pairs like => when the font has them."
        >
          <Switch
            aria-label="Font ligatures"
            checked={settings.codeLigatures}
            onCheckedChange={(codeLigatures) =>
              update.mutate({ codeLigatures })
            }
          />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="Diffs">
        <SettingRow
          id="diff-layout"
          label="Layout"
          description="Auto shows side by side when the diff pane is wide enough."
        >
          <Segmented
            label="Diff layout"
            value={settings.diffLayout}
            onChange={(diffLayout) => update.mutate({ diffLayout })}
            options={[
              { value: 'auto', label: 'Auto' },
              { value: 'unified', label: 'Unified' },
              { value: 'split', label: 'Split' },
            ]}
          />
        </SettingRow>
        <SettingRow
          id="diff-context"
          label="Context lines"
          description="Unchanged lines shown around each change. Hidden lines can always be expanded."
        >
          <Segmented
            label="Context lines"
            value={String(settings.diffContext)}
            onChange={(next) =>
              update.mutate({
                diffContext: Number(next) as Settings['diffContext'],
              })
            }
            options={['3', '5', '10'].map((value) => ({ value, label: value }))}
          />
        </SettingRow>
        <SettingRow
          id="diff-words"
          label="Highlight changed words"
          description="Marks the exact words that changed inside a line."
        >
          <Switch
            aria-label="Highlight changed words"
            checked={settings.diffWordHighlight}
            onCheckedChange={(diffWordHighlight) =>
              update.mutate({ diffWordHighlight })
            }
          />
        </SettingRow>
        <SettingRow
          id="diff-whitespace"
          label="Hide whitespace changes"
          description="The same as git diff -w. Staging still includes them."
        >
          <Switch
            aria-label="Hide whitespace changes"
            checked={settings.diffIgnoreWhitespace}
            onCheckedChange={(diffIgnoreWhitespace) =>
              update.mutate({ diffIgnoreWhitespace })
            }
          />
        </SettingRow>
        <SettingRow
          id="diff-wrap"
          label="Wrap long lines"
          description="Off scrolls long lines sideways inside the diff."
        >
          <Switch
            aria-label="Wrap long lines"
            checked={settings.diffWrap}
            onCheckedChange={(diffWrap) => update.mutate({ diffWrap })}
          />
        </SettingRow>
        <SettingRow
          id="diff-collapse-generated"
          label="Fold generated files"
          description="Lockfiles and minified files open folded, with Show diff. They are still staged and committed as usual."
        >
          <Switch
            aria-label="Fold generated files"
            checked={settings.diffCollapseGenerated}
            onCheckedChange={(diffCollapseGenerated) =>
              update.mutate({ diffCollapseGenerated })
            }
          />
        </SettingRow>
        <SettingRow
          id="diff-syntax"
          label="Syntax highlighting"
          description="Off shows plain text, which is faster on very large diffs."
        >
          <Switch
            aria-label="Syntax highlighting"
            checked={settings.diffSyntax}
            onCheckedChange={(diffSyntax) => update.mutate({ diffSyntax })}
          />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="Preview">
        <div className="py-4">
          <Preview settings={settings} />
        </div>
      </SettingGroup>
    </>
  );
}
