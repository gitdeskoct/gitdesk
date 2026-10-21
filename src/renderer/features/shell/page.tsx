import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { Breadcrumbs, type Crumb } from './breadcrumbs';
import { ConnectionStatus } from './connection-status';

// Settings read best as a single column; app pages use the full content width setting.
const columnWidth = {
  page: 'max-w-(--content-max)',
  narrow: 'max-w-[min(var(--content-max),760px)]',
};

// The workspace surface: flush to the right and bottom window edges, a hairline and a 6px corner
// where it meets the canvas. Header, status line and body share one centered column, so the
// breadcrumb always lines up with the content under it. Only the body scrolls.
export function Page({
  crumbs,
  actions,
  width = 'page',
  children,
}: {
  crumbs: Crumb[];
  actions?: ReactNode;
  width?: keyof typeof columnWidth;
  children: ReactNode;
}) {
  const column = cn('mx-auto w-full', columnWidth[width]);
  return (
    <section className="flex min-w-0 flex-1 flex-col rounded-tl-sm border-t border-l border-line bg-surface">
      <header className="flex h-12 flex-none items-center border-b border-line px-6 min-[1100px]:px-10">
        <div className={cn(column, 'flex items-center justify-between gap-3')}>
          <Breadcrumbs items={crumbs} />
          {actions}
        </div>
      </header>
      <ConnectionStatus column={column} />
      <div className="min-h-0 flex-1 overflow-auto px-6 py-8 min-[1100px]:px-10">
        <div className={cn(column, 'h-full')}>{children}</div>
      </div>
    </section>
  );
}

export function PageTitle({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="mb-7">
      <h1 className="text-xl font-semibold tracking-[-0.02em] text-ink">
        {title}
      </h1>
      {children && (
        <p className="mt-1 text-sm leading-relaxed text-muted">{children}</p>
      )}
    </div>
  );
}
