import type { ReactNode } from 'react';
import { Breadcrumbs, type Crumb } from './breadcrumbs';
import { ConnectionStatus } from './connection-status';

// The workspace surface: flush to the right and bottom window edges, a hairline and a 6px corner where
// it meets the canvas. The header stays put; only the body scrolls.
export function Page({
  crumbs,
  actions,
  children,
}: {
  crumbs: Crumb[];
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex min-w-0 flex-1 flex-col rounded-tl-sm border-t border-l border-line bg-surface">
      <header className="flex h-12 flex-none items-center justify-between gap-3 border-b border-line px-7">
        <Breadcrumbs items={crumbs} />
        {actions}
      </header>
      <ConnectionStatus />
      <div className="min-h-0 flex-1 overflow-auto px-7 py-7">
        <div className="h-full max-w-(--content-max)">{children}</div>
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
