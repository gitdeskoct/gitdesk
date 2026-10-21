import * as RadioGroup from '@radix-ui/react-radio-group';
import type { Settings } from '../../../shared/settings';
import { Segmented } from '../../components/ui/segmented';
import { SettingGroup, SettingRow } from '../../components/ui/setting-row';
import { Minus, Plus } from 'lucide-react';
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
  light: { canvas: '#eef0f3', surface: '#ffffff' },
  dark: { canvas: '#0b0b0d', surface: '#131316' },
};

function Pane({ palette }: { palette: keyof typeof PALETTES }) {
  return (
    <div
      className="flex pt-2 pr-2 pl-7"
      style={{ background: PALETTES[palette].canvas }}
    >
      <div
        className="flex-1 rounded-t-[4px]"
        style={{ background: PALETTES[palette].surface }}
      />
    </div>
  );
}

const THEMES: { value: Settings['theme']; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

// Light and dark values of each tone, matching globals.css, so a swatch shows what the accent will become.
const ACCENTS: {
  value: Settings['accentTone'];
  label: string;
  className: string;
}[] = [
  { value: 'blue', label: 'Blue', className: 'bg-[#2f5bea] dark:bg-[#7f95ff]' },
  {
    value: 'violet',
    label: 'Violet',
    className: 'bg-[#6148d8] dark:bg-[#a28fff]',
  },
  {
    value: 'green',
    label: 'Green',
    className: 'bg-[#1f8a4c] dark:bg-[#4fce87]',
  },
  {
    value: 'amber',
    label: 'Amber',
    className: 'bg-[#ba7400] dark:bg-[#e7b45a]',
  },
  { value: 'rose', label: 'Rose', className: 'bg-[#c14574] dark:bg-[#ff83ad]' },
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
          {/* The one place a card earns its border: it previews the palette being chosen. */}
          <RadioGroup.Root
            aria-label="Theme"
            value={settings.theme}
            onValueChange={(theme) =>
              update.mutate({ theme: theme as Settings['theme'] })
            }
            className="grid max-w-[540px] grid-cols-3 gap-3"
          >
            {THEMES.map((theme) => (
              <RadioGroup.Item
                key={theme.value}
                value={theme.value}
                className="grid gap-2 rounded-sm border border-line p-2 text-left text-[0.8125rem] text-muted hover:border-line-strong data-[state=checked]:border-2 data-[state=checked]:border-accent data-[state=checked]:p-[7px] data-[state=checked]:font-medium data-[state=checked]:text-ink"
              >
                <div
                  className={cn(
                    'grid h-18 overflow-hidden rounded-sm border border-line',
                    theme.value === 'system' && 'grid-cols-2',
                  )}
                >
                  {theme.value !== 'dark' && <Pane palette="light" />}
                  {theme.value !== 'light' && <Pane palette="dark" />}
                </div>
                {theme.label}
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
                  'size-5.5 rounded-sm data-[state=checked]:shadow-[0_0_0_2px_var(--surface),0_0_0_3.5px_var(--ink)]',
                  accent.className,
                )}
              />
            ))}
          </RadioGroup.Root>
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
