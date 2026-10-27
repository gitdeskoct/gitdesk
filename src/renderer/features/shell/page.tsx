import { Component, type ErrorInfo, type ReactNode } from 'react';
import { GitMissingArt } from '../../components/illustrations';
import { Button } from '../../components/ui/button';
import { EmptyState } from '../../components/ui/empty-state';
import { cn } from '../../lib/cn';
import { Breadcrumbs, type Crumb } from './breadcrumbs';
import { ConnectionStatus } from './connection-status';

// Settings read best as a single column; app pages use the content width setting; tables use it all.
const columnWidth = {
  page: 'max-w-(--content-max)',
  narrow: 'max-w-[min(var(--content-max),760px)]',
  // The split dashboard: a main column plus a side column, so it may grow past the reading width.
  wide: 'max-w-[max(var(--content-max),1360px)]',
  full: 'max-w-none',
};

// The workspace surface: flush to the right and bottom window edges, a hairline and a 6px corner
// where it meets the canvas. The breadcrumb header and status line run the full width, anchored to
// the surface's left edge like a window toolbar; the body is a centered reading column. Only the
// body scrolls.
export function Page({
  crumbs,
  actions,
  width = 'page',
  aside,
  fill = false,
  children,
}: {
  crumbs: Crumb[];
  actions?: ReactNode;
  width?: keyof typeof columnWidth;
  /** A non-modal side panel docked to the right of the body (create, clone). */
  aside?: ReactNode;
  /** The body is a full-height frame and its panes scroll on their own (the repository workspace). */
  fill?: boolean;
  children: ReactNode;
}) {
  return (
    <section className="flex min-w-0 flex-1 flex-col rounded-tl-sm border-t border-l border-line bg-surface">
      <header className="flex h-12 flex-none items-center justify-between gap-3 border-b border-line px-6">
        <Breadcrumbs items={crumbs} />
        {actions && (
          <div className="flex shrink-0 items-center gap-2">{actions}</div>
        )}
      </header>
      <ConnectionStatus />
      <div className="flex min-h-0 flex-1">
        {fill ? (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
        ) : (
          <div className="min-w-0 flex-1 overflow-auto px-6 py-8 min-[1100px]:px-10">
            <div className={cn('mx-auto h-full w-full', columnWidth[width])}>
              {children}
            </div>
          </div>
        )}
        {aside}
      </div>
    </section>
  );
}

// One page failing to render must not blank the window: the shell stays and the page says so.
// Main records renderer console errors in the log, so console.error is the log path here.
export class PageErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Page failed to render', error.message, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <Page crumbs={[{ label: 'Error' }]}>
        <EmptyState
          art={<GitMissingArt />}
          title="This page hit an error"
          action={
            <Button onClick={() => location.reload()}>Reload page</Button>
          }
        >
          Your repositories are untouched; reloading usually brings the page
          back.
        </EmptyState>
      </Page>
    );
  }
}

export function PageTitle({
  title,
  eyebrow,
  actions,
  size = 'default',
  children,
}: {
  title: string;
  eyebrow?: ReactNode;
  actions?: ReactNode;
  /** Large is the welcome on Home: the one page that opens the app. */
  size?: 'default' | 'large';
  children?: ReactNode;
}) {
  const large = size === 'large';
  return (
    <div
      className={cn(
        'flex flex-wrap items-end justify-between gap-x-6 gap-y-4',
        large ? 'mb-9' : 'mb-7',
      )}
    >
      <div className="min-w-0">
        {eyebrow && (
          <p
            className={cn(
              'text-muted',
              large ? 'mb-2 text-sm' : 'mb-1.5 text-[0.8125rem]',
            )}
          >
            {eyebrow}
          </p>
        )}
        <h1
          className={cn(
            'font-semibold tracking-[-0.02em] text-ink',
            large ? 'text-[2rem] leading-tight' : 'text-xl',
          )}
        >
          {title}
        </h1>
        {children && (
          <p
            className={cn(
              'leading-relaxed text-muted',
              large ? 'mt-2 text-[0.9375rem]' : 'mt-1 text-sm',
            )}
          >
            {children}
          </p>
        )}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}
