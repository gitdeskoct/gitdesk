import type { ReactNode } from 'react';
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
  children,
}: {
  crumbs: Crumb[];
  actions?: ReactNode;
  width?: keyof typeof columnWidth;
  /** A non-modal side panel docked to the right of the body (create, clone). */
  aside?: ReactNode;
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
        <div className="min-w-0 flex-1 overflow-auto px-6 py-8 min-[1100px]:px-10">
          <div className={cn('mx-auto h-full w-full', columnWidth[width])}>
            {children}
          </div>
        </div>
        {aside}
      </div>
    </section>
  );
}

export function PageTitle({
  title,
  eyebrow,
  actions,
  children,
}: {
  title: string;
  eyebrow?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="mb-7 flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
      <div className="min-w-0">
        {eyebrow && <p className="mb-1.5 text-[0.8125rem] text-muted">{eyebrow}</p>}
        <h1 className="text-xl font-semibold tracking-[-0.02em] text-ink">
          {title}
        </h1>
        {children && (
          <p className="mt-1 text-sm leading-relaxed text-muted">{children}</p>
        )}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}
