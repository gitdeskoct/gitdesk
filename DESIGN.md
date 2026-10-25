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

## Long paths and URLs

A folder path, remote URL or Git URL that doesn't fit loses its middle, never its end: the last segment (`\search-app`, `<id>.git`) stays whole and the start shortens with an ellipsis (`LongValue` / `MiddleTruncate` in `components/ui/long-value.tsx`). Where the value is something to reuse, a ghost copy button sits right after it and copies the whole value; a folder is copied by main, so `~` comes out as the real path. Rows that are buttons themselves show the shortened value only, with Copy path in their menu.

## Repositories

- **One list, three overlapping sets.** Local is registered on this computer, Remote is in the account, Linked is both. The statistics strip is the filter and says the counts overlap. State filters (Changed, Ahead and so on) only match repositories on this computer.
- **Two layouts, one set of components.** Centered shows the table in the content column. Split shows the list beside the selected repository; arrows move the selection and Enter opens the full page. Under 860px of content (1100px for Auto) split falls back to the list, and a row opens its page. The choice lives in Settings › Workspace.
- **Charts answer a question.** The details chart is titled with the question it answers, counts commits reachable from the current branch per local-time week by commit date, and has a text summary and a hidden table for screen readers. Bars are focusable and name their week. No scores, no percentages of health.
- **Words, not zeros.** A number that has nothing to compare against says so (Not connected), and an unchecked folder is never called safe to delete.

## Repository workspace

- **Tabs, not pages.** A repository opens on Changes (or its own "Opens on" choice) with History, Branches, Remotes, Overview and Settings beside it. Switching tabs never remounts the shell; the header with the branch picker, status and Fetch stays put.
- **Two layouts, one set of components.** Split puts the changed files beside the diff and History beside the commit detail. Centered is one reading column where a file opens its diff in place. Auto splits from 960px of workspace; Split asks for 700px and below that becomes one column where a file replaces the list until "All changed files". The choice is global (Settings › Workspace) and each repository can override it (its Settings tab).
- **Git's states stay apart.** Conflicts, Staged, Not staged and Untracked are separate groups, and a file with staged and unstaged edits appears in both. Ignored files never appear and Stage all never stages them.
- **Local means local.** The commit button names the branch and says the commit stays on this computer until you push. Fetch updates remote-tracking branches only and says so.
- **Git decides what is safe.** A switch that would overwrite edits is refused by Git; gitdesk lists the files in a warning band and never forces or stashes. Discard confirms inline in a `danger-soft` band that names the files; untracked files go to the system trash.
- **The header is one row.** Name, tags, description and path sit on the left; branch picker, status chips, "Fetched …" and Fetch on the right. It wraps instead of stacking, so the tabs start close to the top.
- **The commit message folds away.** In the split file pane, Hide folds the summary and description into one row (Show message, the summary so far, Commit). The choice is remembered on this computer. Committing with no summary opens the fields and focuses Summary instead of failing out of sight.
- **Authors are 6px squares.** Your own commits (matched by your gitdesk account email or your global Git email) show your gitdesk account picture, or initials on the accent tint when there is no picture. Everyone else gets initials on `control`. gitdesk never asks another service for pictures.
- **Size is measured, not guessed.** Repository Settings shows the folder on disk split into Git history (`chart-1`), files in the last commit (`chart-2`) and everything else (`faint`), with a stacked bar, a sentence and the largest tracked files. It re-measures after status changes (cached 30 seconds) and on Measure again. A very large folder stops counting and says the numbers are a lower bound. Rounding never says 0% or 100% about a part that is neither.

## Pull requests

- **Git decides, the record describes.** Comparisons, checks, merges, conflicts and reverts are Git's on this computer. The record (title, comments, reviews, activity) lives on this computer for an unlinked repository and in the account for a linked one, and every list and page says which with a Local or Account tag.
- **Two layouts, one set of components.** Centered lists pull requests in the content column with the Open, Merged and Closed counts as the filter. Split shows the list beside the selected one; arrows move the selection and Enter opens the review. Under 860px of workspace (1100px for Auto) split falls back to the list. The choice lives in Settings › Pull requests.
- **New is inline.** Creating a pull request happens in the tab, never a modal, and the comparison (commits, files, lines, merge base) shows before anything is saved. Pairs Git can't compare are refused with a reason, and a reversed pair offers Swap.
- **Snapshots, not branch names.** A review, a line comment and a check name the exact commits they saw. When either branch moves, a new snapshot starts: an older approval is marked stale, a moved line keeps its comment, and a line that changed marks its thread Outdated rather than pinning it somewhere wrong.
- **Mergeability is words.** Not checked, Mergeable, a count of conflicts, or Unavailable with the reason (Git too old, no shared history). A check never touches the working tree, and it is redone before a merge.
- **Merging asks first, inline.** The Merge tab lists what was checked, the two methods (default, or always a merge commit) and the push choice, then confirms in a band that names both branches. Uncommitted changes refuse the merge; gitdesk never stashes. A stale approval, requested changes and unresolved threads are warnings, never blocks.
- **Partial success says so.** A merge that worked here but couldn't push reads "Merged locally · Push pending" with Push again. One the account hasn't heard about yet is retried with the same operation, so it is never recorded twice.
- **Conflicts are a screen, not a toast.** Each conflicted file shows the target and source versions with a Use button each, the working file with its markers labelled, Open in editor, and Mark resolved, which stays unavailable while markers remain. Continue stays unavailable until Git reports no unmerged file; Abort confirms in a `danger-soft` band.
- **Revert adds, never erases.** A merged pull request offers a revert onto a new branch or the target. For a merge commit the side to keep is a choice that names both parents. The pull request stays merged. A revert on a new branch ends with Open a pull request, which opens the form with that branch and the target already chosen.
- **Choice lists use round radio marks.** The one exception to the 6px rule: a radio is round so it never reads as a checkbox.

## Git hosting

- **The URL is safe to show.** The hosted Git URL holds no credentials, so it is shown in full in a sunken mono field with a copy button, on the Remotes tab and the remote repository page. It says so under the field.
- **Tokens stay out of sight.** No screen ever shows a token. Copy terminal command copies a command and says only until when its token works; its row also says that anyone who sees the command can push until then.
- **Revoke confirms inline**, in a `danger-soft` band that names the repository and says copied commands stop working.
- **Push never forces.** The header shows Push with the count the upstream doesn't have yet. A refused push explains fetching and merging first; it never offers to force.
- **Off is a state, not an error.** When the server has Git hosting off, the URL row says so in words, the clone button stays unavailable with the reason beside it, and Settings › Git hosting shows Off with a warning icon and Check again, so a server that turns hosting on shows up without waiting for the next account refresh.

## Remote sync

- **Git's states, in words.** The Sync tab names one of Up to date, Ahead, Behind, Diverged, No upstream and Upstream gone in a sentence, with To push, To pull, Changed files and Remote last checked in the strip. Gone never claims a deletion Git can't see: the branch may have been deleted or never pushed. A branch with no commits yet (an empty clone) is new, not gone, and offers no Publish until its first commit. Counts from a fetch over an hour old say so, in the strip and in a "Checked …" chip in the header.
- **Pull never surprises.** Fast-forward only is the default (Settings › Sync). Diverged histories disable it and a warning band names Merge or Rebase; the choice on the tab is for one pull. A merge or rebase that conflicts opens the shared conflict screen in its own words (Yours and Incoming), a rebase one replayed commit at a time; Abort puts the branch back where it was. gitdesk never stashes and never force-pushes.
- **Unknown is a state.** A push cut off after its data was sent is "Push result unknown", with Check status, which asks the remote. Nothing is pushed again until then.
- **Confirmed means the server found it.** A push to the account's Git URL is reported by operation id and checked against Artifacts; Sync activity tags it Confirmed by server, Not confirmed or Refused, and its chart asks "Did your pushes reach the server?".
- **Compare is split, then files.** Commits only here beside commits only on the upstream, stacked under 860px; below them each side's files with a Shiki diff.
- **Moving is reversible.** Move to gitdesk copies every branch and tag, checks each on the server, and only then points origin at gitdesk; the replaced remotes are kept on this computer for Undo. It is offered in an accent band, never a danger band.
- **A new project gets its private remote by itself** once signed in (Settings › Git hosting). Signed out, it waits and says so; a taken name asks for another. Nothing is pushed until Publish.

## Code and diffs

- **Syntax colors are the one place color is not state.** Recorded against R-37: the owner asked for Shiki highlighting. Themes come in light and dark pairs (GitHub is the default), and every token color is moved toward ink or white until it reaches 4.5:1 on all of the backgrounds below, so no theme ships unreadable tokens.
- **Meaning never rests on a tint.** Every diff line has a `+`, `−` or blank glyph column with a screen-reader label. Changed words are tinted and underlined when added, struck through when removed. Conflict markers carry a label ("Your side starts").
- **Tints are solid tokens.** `--diff-add`, `--diff-del`, `--diff-add-word`, `--diff-del-word`, `--diff-hunk`, with dark values in `globals.css`.
- **Code text follows Settings › Code.** Font (`--code-font`, set through CSSOM), size, line height, tab width and ligatures, through the `code-text` utility.

| Pairing (light / dark)              | Ratio              |
| ----------------------------------- | ------------------ |
| ink on diff-add / diff-del          | 16.31 / 15.85      |
| ink on add-word / del-word          | 13.79 / 12.53      |
| muted on diff-add / diff-del / hunk | 5.52 / 5.36 / 5.67 |
| dark ink on diff-add / diff-del     | 14.44 / 15.16      |
| dark ink on add-word / del-word     | 8.98 / 10.81       |
| dark muted on diff-add / diff-del   | 7.23 / 7.59        |

## Charts

- **Series colors are fixed, not the accent.** `--chart-1` (#2f5bea, dark #6f86f0) and `--chart-2` (#c8641a, dark #c97436) passed the dataviz validator for color-blind separation in both themes, and reach 3:1 as marks (5.52 / 3.97 light, 5.60 / 5.33 dark). The heat ramp is five steps of chart-1.
- **Every chart answers a question** in its title, says the answer in a sentence under it, has a tooltip per mark and a table view ("Show as tables"). Author names are labelled as Git settings, not verified identities. Lockfile-sized changes are left out of line counts and named.

## Destructive confirmations

Removing a repository from gitdesk, removing several, disconnecting a remote, moving a folder to the system trash and deleting a remote repository all confirm **inline**, in a `danger-soft` band where the action was taken. Each names the one thing it touches. Moving a folder to the trash and deleting a remote also ask for the name to be typed: the first shows the folder path and any uncommitted changes, the second can't be undone. A folder is only ever moved to the trash, never deleted outright.

There are no centered modals. _Why: the CSP blocks the style tag a modal's scroll lock injects, and an inline band keeps the context visible._

## Progress

Long work with a known end (cloning, creating) shows a 6px `accent` bar on a `control` track with a 4px corner, with its stage on the left and its percent or step on the right. Under the bar:

- **Transfer**, when Git reports it: speed in bold, bytes received, time left. These are measured from Git's own progress line.
- **Connection**, while the step uses the network: four bars plus words ("Good connection · 45 ms · about 10 Mbps"). The values are the system's estimate and read "about"; the words carry the meaning, the bar color only repeats it.

Work without a known end uses the spinner.

## Focus

Focus is a 2px solid `accent` outline at a 2px offset (`:focus-visible` in `globals.css`). It is never removed without a visible replacement.
