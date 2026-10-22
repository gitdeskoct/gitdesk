# gitdesk design

This is the owner's design direction for the gitdesk renderer. `src/renderer/styles/globals.css` implements it. When the two disagree, this file states the intent and the CSS is the thing to fix.

## Principles

- **Flat and solid.** Solid colors only. No gradients, no glows, no glass. _Why: a Git client is read for hours, and flat color keeps attention on diffs and history, not on chrome._
- **Cardless, content first.** Content sits directly on the surface. Grouping comes from headings, spacing and hairlines, not from boxes. _Why: cards add borders and padding around every list and form, and a dense tool cannot spare that space._
- **Full height.** Every screen fills the window. No floating centered panels with empty canvas around them. _Why: a desktop app should feel like a workspace, not a web page._

## Dials

| Dial   | Value | What it means here                                                             |
| ------ | ----- | ------------------------------------------------------------------------------ |
| ENERGY | 1     | Neutral surfaces, one accent, color reserved for state and the primary action. |
| RHYTHM | 2     | A steady 6px spacing scale with predictable section structure.                 |
| MOTION | 1     | The logo draw-in, the sign-in tiles and state transitions. Nothing loops.      |

## Palette

Light values below are the owner's exact hex values. Dark values match `globals.css`. Every color is a CSS custom property on `:root`, mapped into Tailwind through `@theme inline` (`bg-surface`, `text-muted` and so on). Components use tokens, never raw hex.

```css
:root {
  --canvas: #eef0f3;
  --surface: #ffffff;
  --sunken: #f5f6f8;
  --line: #dde1e7;
  --line-strong: #c6ccd5;
  --ink: #14161a;
  --muted: #5b6270;
  --faint: #8a919c;
  --accent: #2f5bea;
  --accent-hover: #2549c4;
  --accent-soft: #e6ecfd;
  --on-accent: #ffffff;
  --record: #d93a2b;
  --record-soft: #fbe7e5;
  --success: #1f8a4c;
  --success-soft: #e3f3ea;
  --warning: #a86a12;
  --warning-soft: #fbf0dc;
  --danger: #c4322b;
  --danger-soft: #fbe6e5;
}

@media (prefers-color-scheme: dark) {
  :root {
    --canvas: #0b0b0d;
    --surface: #131316;
    --sunken: #0f1012;
    --line: #222327;
    --line-strong: #32343a;
    --ink: #f1f1f3;
    --muted: #a8adb7;
    --faint: #7e838f;
    --accent: #7f95ff;
    --accent-hover: #98a9ff;
    --accent-soft: #1f2540;
    --on-accent: #0d1020;
    --record: #ff6f64;
    --record-soft: #3a1d1b;
    --success: #4fce87;
    --success-soft: #143022;
    --warning: #e7b45a;
    --warning-soft: #32260f;
    --danger: #ff6f64;
    --danger-soft: #3a1d1b;
  }
}
```

### Accent tones

Blue is the default (`accentTone: 'blue'`, the values above). The other tones override four tokens through `:root[data-accent-tone='...']`.

| Tone   | Mode  | `--accent` | `--accent-hover` | `--accent-soft` | `--on-accent` |
| ------ | ----- | ---------- | ---------------- | --------------- | ------------- |
| violet | light | #6148d8    | #5038b8          | #ece8ff         | #ffffff       |
| green  | light | #1f8a4c    | #267b47          | #e3f3ea         | #ffffff       |
| amber  | light | #ba7400    | #9f6600          | #f7edda         | #241603       |
| rose   | light | #c14574    | #a73b64          | #f9e7ee         | #ffffff       |
| violet | dark  | #a28fff    | #b7a8ff          | #30254b         | #0f0820       |
| green  | dark  | #4fce87    | #6fdaa0          | #153025         | #081d12       |
| amber  | dark  | #e7b45a    | #efc680          | #38280f         | #241603       |
| rose   | dark  | #ff83ad    | #ff9fc0          | #3c1d2b         | #260d17       |

Light amber is the only tone with dark text on the accent fill. _Why: white on #ba7400 is too weak, and #241603 reads clearly on it._

### Roles

- `canvas` is the app background, shared by the title bar and sidebar. `surface` is the workspace. `sunken` is for wells, hovers and inputs.
- `ink` is primary text. `muted` is descriptions, metadata and secondary labels.
- `faint` is for SVG line art, disabled glyphs and decorative strokes. **It is never used for text.**
- `accent` marks the primary action, the selection and focus. One primary action per view.
- `success`, `warning`, `danger` and `record` are for state only, never decoration.

## Contrast

Measured with `.agents/skills/antislop-human/contrast-check.py` (WCAG 2.x relative luminance). AA is 4.5:1 for normal text and 3:1 for large text (18px and up) and for non-text UI.

### Light

| Pairing                                   | Ratio                 | Result                  |
| ----------------------------------------- | --------------------- | ----------------------- |
| ink on surface / sunken / canvas          | 18.11 / 16.75 / 15.86 | AA                      |
| muted on surface / sunken / canvas        | 6.13 / 5.67 / 5.37    | AA                      |
| faint on surface / sunken / canvas        | 3.18 / 2.94 / 2.78    | Not text (see rules)    |
| accent on surface / canvas                | 5.52 / 4.83           | AA                      |
| on-accent on accent / accent-hover        | 5.52 / 7.42           | AA                      |
| accent on accent-soft                     | 4.67                  | AA                      |
| success on surface                        | 4.38                  | Accepted exception      |
| warning on surface                        | 4.43                  | Accepted exception      |
| success on success-soft                   | 3.81                  | Below AA                |
| warning on warning-soft                   | 3.93                  | Below AA                |
| danger on surface / danger-soft           | 5.47 / 4.57           | AA                      |
| record on surface                         | 4.57                  | AA                      |
| violet: white on #6148d8 / #5038b8        | 6.13 / 8.08           | AA                      |
| green: white on #1f8a4c / #267b47         | 4.38 / 5.24           | Accepted exception / AA |
| amber: #241603 on #ba7400 / #9f6600       | 4.69 / 3.67           | AA / Below AA           |
| amber #ba7400 as text on surface / canvas | 3.76 / 3.29           | Below AA                |
| rose: white on #c14574 / #a73b64          | 4.80 / 6.08           | AA                      |

### Dark

| Pairing                               | Ratio              | Result                       |
| ------------------------------------- | ------------------ | ---------------------------- |
| ink on surface / canvas               | 16.44 / 17.43      | AA                           |
| muted on surface / canvas             | 8.24 / 8.73        | AA                           |
| faint on surface / canvas             | 4.88 / 5.18        | AA (still not used for text) |
| accent on surface                     | 6.75               | AA                           |
| on-accent on accent / accent-hover    | 6.87 / 8.50        | AA                           |
| success / warning / danger on surface | 9.28 / 9.78 / 6.81 | AA                           |
| violet on-accent on accent / hover    | 7.35 / 9.35        | AA                           |
| green on-accent on accent / hover     | 8.80 / 10.22       | AA                           |
| amber on-accent on accent / hover     | 9.30 / 10.96       | AA                           |
| rose on-accent on accent / hover      | 7.90 / 9.52        | AA                           |

### Rules that follow from the numbers

- **Accepted exception.** The owner accepted success, warning and the green accent at 4.38 to 4.43:1 on white. Wherever they carry text, they are always paired with an icon or set at weight 600, so meaning never rests on a thin colored word.
- **faint (3.18:1 on white) is never used for text** in either mode, including placeholders, timestamps and disabled labels. Use `muted`.
- **Open items, not covered by the exception.** Success and warning on their soft fills (3.81 and 3.93), the light amber hover fill (3.67) and light amber as text (3.76 on surface) are below 4.5:1. Until the owner decides, do not set small text in these pairings: put soft-fill badges in `ink` with a colored icon, and do not use the amber accent as a text or link color in light mode.

## Layout

Hierarchy is **Page → Section → Component**. A page has one title. Sections are separated by headings and space, with a hairline (`line`) where a divider is needed. Components sit in sections without a card around them.

- **Shell.** The title bar and the sidebar share the `canvas` color, so they read as one frame.
- **Title bar.** 44px tall (`TITLE_BAR_HEIGHT` in `src/main/window.ts`). The window uses a hidden title bar with native window controls overlaid in canvas colors, so the frame never flashes a different color on load.
- **Menu bar.** On Windows and Linux the title bar carries an in-window File, Edit, View and Help menu (Radix Menubar). The native menu is removed there, which also removes its Reload and DevTools accelerators. macOS keeps a minimal native menu. Every menu item has real behavior, and its shortcut comes from the same list as Settings › Shortcuts. _Why: a desktop app is expected to have menus, and one shortcut list can't drift from what the menu says._
- **Workspace surface.** The `surface` panel is flush to the right and bottom window edges and has a single 6px corner at the top left, where it meets the sidebar and title bar.
- **Breadcrumb header.** 48px tall, at the top of the workspace surface.
- **Content width.** Content is centered in the workspace up to `--content-max`: 840px (compact), 1020px (default) or 1160px (wide), from the `contentWidth` setting. _Why: long lines are hard to scan, and users on wide monitors can opt into more._
- **One centered column.** The breadcrumb header, the status line and the page body share one centered column, so the breadcrumb always lines up with the content under it. Settings use a narrower column (at most 760px) because they read as a single list. Side padding is 24px, and 40px from 1100px wide. _Why: content pressed against the sidebar edge reads as unfinished._
- **Rows.** A setting row's text column flexes and its control never shrinks, so controls stay on the right at every width instead of dropping under the text.
- **Spacing.** A 6px scale: 6, 12, 18, 24, 30 and 36px (`--space-1` to `--space-6`). _Why: it lines up with the 6px radius, so edges and gaps share one rhythm._

## Shape

- **Every corner is 6px.** Buttons, inputs, menus, popovers, dialogs, tooltips, the workspace surface.
- **Inner parts are 4px.** Anything nested inside a 6px element, such as a menu item highlight, a segmented control thumb or a tag inside a field.
- No pills and no other radii. _Why: one radius makes the interface feel built from one material, and 6px is soft without looking rounded._

## Type

- **Inter** (the owner's choice), bundled through `@fontsource-variable/inter` so it works offline. A `system` font setting swaps in the platform UI font. _Why Inter: it is designed for screens, stays legible at small sizes and has tabular figures for hashes, counts and times._
- **16px base.** The `fontSize` setting gives 14px (small), 16px (default) or 18px (large) at the root, and everything scales in rem from there.
- **Headings** are semibold (600) with tight tracking and line height.
- **Descriptions** under headings and settings rows are `muted`, at regular weight.
- Code, hashes and paths use the mono stack.

## Icons

- **Lucide** (the owner's choice, `lucide-react`). Line icons only, at the size the component sets (16px in buttons). _Why Lucide: its consistent stroke style matches the line logo and line empty states, and it is tree-shaken per icon._
- Icons inherit `currentColor`. A decorative icon is `aria-hidden`. An icon-only button has an accessible label and a tooltip.

## Motion

The `motion` setting has three levels, applied as `data-motion` on the root:

- **Full.** Transitions on state changes, the logo draw-in and the sign-in tiles. When the OS asks for reduced motion, `globals.css` cuts Full's transitions to near-instant.
- **Reduced.** Less motion than Full, for users who want it without changing the OS setting.
- **Off.** All animations and transitions are disabled (`globals.css` forces `animation: none` and `transition: none`).

Rules:

- **The logo draws in once** when it first appears, and reacts to hover. It never loops or idles.
- **Sign-in wobble tiles follow the pointer only.** They are still when the pointer is still, with no autoplay and no ambient drift.
- Nothing loops except a spinner while work is pending.

_Why: motion should confirm that something happened. Looping motion competes with the content and costs battery._

## Logo

- A line mark drawn in `currentColor`, so it takes the color of the text around it in both modes.
- No fill, no background, no gradient.
- Legible at 16px, so the same mark works at title bar and sidebar sizes.

## Empty states

Every empty state has exactly:

1. A line SVG drawn in `faint`, with **one** node in the accent color.
2. A title.
3. One sentence that says what will appear here or why it is empty.
4. One action, the most likely next step.

No illustrations with fills, no stock art, no second button. _Why: an empty view is a prompt to act, and one clear action does that better than decoration._

## Spinners

A button that starts async work shows a spinner while the work is pending.

- The spinner is **mounted only while pending**, not hidden with CSS.
- The **label stays** next to it, so the button does not change width or meaning.
- The button **stays focusable** while pending, so keyboard focus is not lost.
- The spinner SVG is `aria-hidden`. The label carries the meaning.

## Toasts

Short results of actions whose own UI has already closed: a menu item, a bulk action, a copy.

- **Flat.** `surface` fill, `line` border, 6px corner, the menu shadow (it floats, like a menu). Bottom right, at most three.
- **Icon plus title.** Success and danger color the icon only; the text stays `ink` and `muted`.
- **Never a decision.** Anything that needs an answer stays inline on the page. Errors stay 8 seconds, everything else 4.
- **F8** moves focus to the toasts (Radix default).

_Why: a closed menu can't show its own spinner or error, and a result that vanishes silently reads as nothing happened._

## Notifications

One rule: a **system notification** while gitdesk is in the background, the **in-app toast** while it is in front. The same notice never goes out twice within a minute, and nothing notifies about ordinary edits. Clicking a system notification brings gitdesk forward and opens the repository it names.

## Pagination

Lists on Home show 6 items per page by default (Settings › Workspace offers 10 and 20). The count sits on the left ("7–12 of 31"), the pages on the right: previous, numbers that collapse with an ellipsis past five pages, next. The current page is the `control` fill in `ink`; arrow keys turn pages while the pager has focus. One page needs no pager.

## Destructive confirmations

Removing a repository from gitdesk, removing several, and deleting a remote repository all confirm **inline**, in a `danger-soft` band where the action was taken. Deleting a remote also asks for its name to be typed, because it can't be undone.

There are no centered modals. _Why: the CSP blocks the style tag a modal's scroll lock injects, and an inline band keeps the context visible._

## Progress

Long work with a known end (cloning, creating) shows a 6px `accent` bar on a `control` track with a 4px corner, with its stage on the left and its percent or step on the right. Under the bar:

- **Transfer**, when Git reports it: speed in bold, bytes received, time left. These are measured from Git's own progress line.
- **Connection**, while the step uses the network: four bars plus words ("Good connection · 45 ms · about 10 Mbps"). The values are the system's estimate and read "about"; the words carry the meaning, the bar color only repeats it.

Work without a known end uses the spinner.

## Focus

Focus is a 2px solid `accent` outline at a 2px offset (`:focus-visible` in `globals.css`). It is never removed without a visible replacement.
