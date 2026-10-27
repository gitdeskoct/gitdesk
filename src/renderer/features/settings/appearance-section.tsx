import * as RadioGroup from '@radix-ui/react-radio-group';
import type { Settings } from '../../../shared/settings';
import { Segmented } from '../../components/ui/segmented';
import { SettingGroup, SettingRow } from '../../components/ui/setting-row';
import { Switch } from '../../components/ui/switch';
import { Check, Minus, Plus } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { cn } from '../../lib/cn';
import {
  clampZoom,
  shortcutText,
  ZOOM_STEP,
  zoomPercent,
} from '../../lib/shortcuts';
import { useSettings, useUpdateSettings } from '../../lib/queries';
import { PageTitle } from '../shell/page';

// Previews show the fixed light and dark palettes, so these are literal values on purpose.
const PALETTES = {
  light: {
    canvas: '#eef0f3',
    surface: '#ffffff',
    raised: '#ffffff',
    line: '#dde1e7',
    chrome: '#c6ccd5',
    ink: '#14161a',
    accent: '#2f5bea',
  },
  dark: {
    canvas: '#0b0b0d',
    surface: '#131316',
    raised: '#1f2126',
    line: '#222327',
    chrome: '#32343a',
    ink: '#f1f1f3',
    accent: '#7f95ff',
  },
};

// A miniature of the app in one palette: title bar, sidebar with the active item, and a page.
function MiniApp({ palette }: { palette: keyof typeof PALETTES }) {
  const c = PALETTES[palette];
  const bar = (width: string, color: string, height = 5) => (
    <span
      className="block rounded-[2px]"
      style={{ width, height, background: color }}
    />
  );
  return (
    <span
      className="flex min-w-0 flex-1 flex-col"
      style={{ background: c.canvas }}
    >
      <span className="flex h-[12%] items-center gap-1 px-2">
        {bar('5px', c.chrome)}
        {bar('5px', c.chrome)}
      </span>
      <span className="flex flex-1">
        <span className="grid w-[26%] content-start gap-1.5 px-1.5 py-2">
          {bar('100%', c.raised, 6)}
          {bar('80%', c.line)}
          {bar('70%', c.line)}
        </span>
        <span
          className="grid flex-1 content-start gap-[7px] rounded-tl-[4px] p-2.5"
          style={{ background: c.surface }}
        >
          {bar('45%', c.ink, 6)}
          {bar('100%', c.line)}
          {bar('80%', c.line)}
          {bar('24%', c.accent, 9)}
        </span>
      </span>
    </span>
  );
}

const THEMES: { value: Settings['theme']; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

// Light and dark values of each tone, matching globals.css, so a swatch shows what the accent will
// become. The check uses that tone's on-accent color so it stays readable on light amber.
const ACCENTS: {
  value: Settings['accentTone'];
  label: string;
  className: string;
}[] = [
  {
    value: 'blue',
    label: 'Blue',
    className: 'bg-[#2f5bea] text-white dark:bg-[#7f95ff] dark:text-[#0d1020]',
  },
  {
    value: 'violet',
    label: 'Violet',
    className: 'bg-[#6148d8] text-white dark:bg-[#a28fff] dark:text-[#0f0820]',
  },
  {
    value: 'green',
    label: 'Green',
    className: 'bg-[#1f8a4c] text-white dark:bg-[#4fce87] dark:text-[#081d12]',
  },
  {
    value: 'amber',
    label: 'Amber',
    className:
      'bg-[#ba7400] text-[#241603] dark:bg-[#e7b45a] dark:text-[#241603]',
  },
  {
    value: 'rose',
    label: 'Rose',
    className: 'bg-[#c14574] text-white dark:bg-[#ff83ad] dark:text-[#260d17]',
  },
];

export function AppearanceSection() {
  const { data: settings } = useSettings();
  const update = useUpdateSettings();
  if (!settings) return null;

  return (
    <>
      <PageTitle title="Appearance">
        How gitdesk looks on this computer.
      </PageTitle>
      <SettingGroup>
        <SettingRow
          id="theme"
          label="Theme"
          description="System follows your computer's light or dark setting."
          stacked
        >
          <RadioGroup.Root
            aria-label="Theme"
            value={settings.theme}
            onValueChange={(theme) =>
              update.mutate({ theme: theme as Settings['theme'] })
            }
            orientation="horizontal"
            className="grid grid-cols-3 gap-4 pt-1"
          >
            {THEMES.map((theme) => (
              <RadioGroup.Item
                key={theme.value}
                value={theme.value}
                className="group grid gap-2.5 rounded-sm text-left text-[0.8125rem] text-muted focus-visible:outline-offset-4"
              >
                {/* The preview is the one place a frame earns its keep: it shows the palette being chosen. */}
                <span className="flex aspect-[16/10] overflow-hidden rounded-sm shadow-[0_0_0_1px_var(--line)] transition-shadow group-hover:shadow-[0_0_0_1px_var(--line-strong)] group-data-[state=checked]:shadow-[0_0_0_2px_var(--accent)]">
                  {theme.value !== 'dark' && <MiniApp palette="light" />}
                  {theme.value !== 'light' && <MiniApp palette="dark" />}
                </span>
                <span className="flex items-center justify-between group-data-[state=checked]:font-semibold group-data-[state=checked]:text-ink">
                  {theme.label}
                  <Check
                    aria-hidden
                    className="size-4 text-accent opacity-0 group-data-[state=checked]:opacity-100"
                  />
                </span>
              </RadioGroup.Item>
            ))}
          </RadioGroup.Root>
        </SettingRow>
        <SettingRow
          id="accent"
          label="Accent"
          description="Buttons, selection and focus."
        >
          <RadioGroup.Root
            aria-label="Accent"
            value={settings.accentTone}
            onValueChange={(accentTone) =>
              update.mutate({
                accentTone: accentTone as Settings['accentTone'],
              })
            }
            orientation="horizontal"
            className="flex gap-2"
          >
            {ACCENTS.map((accent) => (
              <RadioGroup.Item
                key={accent.value}
                value={accent.value}
                aria-label={accent.label}
                className={cn(
                  'group grid size-6 place-items-center rounded-sm',
                  accent.className,
                )}
              >
                <Check
                  aria-hidden
                  strokeWidth={3}
                  className="size-3.5 opacity-0 group-data-[state=checked]:opacity-100"
                />
              </RadioGroup.Item>
            ))}
          </RadioGroup.Root>
        </SettingRow>
        <SettingRow
          id="contrast"
          label="Contrast"
          description="More darkens dividers and secondary text in light mode and brightens them in dark mode. The accent stays as it is."
        >
          <Segmented
            label="Contrast"
            value={settings.contrast}
            onChange={(contrast) => update.mutate({ contrast })}
            options={[
              { value: 'standard', label: 'Standard' },
              { value: 'more', label: 'More' },
            ]}
          />
        </SettingRow>
        <SettingRow
          id="underline-links"
          label="Always underline links"
          description="Off underlines a link only under the pointer."
        >
          <Switch
            aria-label="Always underline links"
            checked={settings.underlineLinks}
            onCheckedChange={(underlineLinks) =>
              update.mutate({ underlineLinks })
            }
          />
        </SettingRow>
        <SettingRow
          id="tooltip-delay"
          label="Tooltips"
          description="How soon names appear over icon buttons and the collapsed sidebar."
        >
          <Segmented
            label="Tooltips"
            value={settings.tooltipDelay}
            onChange={(tooltipDelay) => update.mutate({ tooltipDelay })}
            options={[
              { value: 'standard', label: 'After a moment' },
              { value: 'instant', label: 'Right away' },
            ]}
          />
        </SettingRow>
        <SettingRow
          id="text-size"
          label="Text size"
          description="Scales the whole interface."
        >
          <Segmented
            label="Text size"
            value={settings.fontSize}
            onChange={(fontSize) => update.mutate({ fontSize })}
            options={[
              { value: 'small', label: 'Small' },
              { value: 'default', label: 'Default' },
              { value: 'large', label: 'Large' },
            ]}
          />
        </SettingRow>
        <SettingRow
          id="font"
          label="Font"
          description="Inter, or the font your system uses."
        >
          <Segmented
            label="Font"
            value={settings.fontFamily}
            onChange={(fontFamily) => update.mutate({ fontFamily })}
            options={[
              { value: 'inter', label: 'Inter' },
              { value: 'system', label: 'System' },
            ]}
          />
        </SettingRow>
        <SettingRow
          id="motion"
          label="Motion"
          description="Reduced also follows your system setting."
        >
          <Segmented
            label="Motion"
            value={settings.motion}
            onChange={(motion) => update.mutate({ motion })}
            options={[
              { value: 'full', label: 'Full' },
              { value: 'reduced', label: 'Reduced' },
              { value: 'off', label: 'Off' },
            ]}
          />
        </SettingRow>
        <SettingRow
          id="content-width"
          label="Content width"
          description="How wide pages can grow."
        >
          <Segmented
            label="Content width"
            value={settings.contentWidth}
            onChange={(contentWidth) => update.mutate({ contentWidth })}
            options={[
              { value: 'compact', label: 'Compact' },
              { value: 'default', label: 'Default' },
              { value: 'wide', label: 'Wide' },
            ]}
          />
        </SettingRow>
        <SettingRow
          id="zoom"
          label="Zoom"
          description={`Use ${shortcutText('zoomIn')} to zoom in and ${shortcutText('zoomOut')} to zoom out.`}
        >
          <div className="flex items-center gap-1.5">
            <Button
              size="icon"
              aria-label="Zoom out"
              disabled={settings.zoomLevel <= -3}
              onClick={() =>
                update.mutate({
                  zoomLevel: clampZoom(settings.zoomLevel - ZOOM_STEP),
                })
              }
            >
              <Minus />
            </Button>
            <output
              className="min-w-12 text-center text-[0.8125rem] text-ink tabular-nums"
              aria-live="polite"
            >
              {zoomPercent(settings.zoomLevel)}%
            </output>
            <Button
              size="icon"
              aria-label="Zoom in"
              disabled={settings.zoomLevel >= 3}
              onClick={() =>
                update.mutate({
                  zoomLevel: clampZoom(settings.zoomLevel + ZOOM_STEP),
                })
              }
            >
              <Plus />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={settings.zoomLevel === 0}
              onClick={() => update.mutate({ zoomLevel: 0 })}
            >
              Reset
            </Button>
          </div>
        </SettingRow>
      </SettingGroup>
    </>
  );
}
