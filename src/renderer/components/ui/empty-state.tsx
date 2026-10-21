import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

// One drawing, one sentence, one action, always in that order. The full form fills the workspace
// body so it sits in the optical center; the compact form is for side columns and panels.
// `action` is required: an empty view is a prompt to act (DESIGN.md › Empty states).
export function EmptyState({
  art,
  title,
  children,
  action,
  compact = false,
  className,
}: {
  art: ReactNode;
  title: string;
  children: ReactNode;
  action: ReactNode;
  compact?: boolean;
  className?: string;
}) {
  if (compact) {
    return (
      <div className={cn('flex items-center gap-4 py-4', className)}>
        <div className="shrink-0 text-faint [&_svg]:h-auto [&_svg]:w-16">
          {art}
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-ink">{title}</h3>
          <p className="mt-0.5 mb-2 text-[0.8125rem] leading-relaxed text-muted">
            {children}
          </p>
          {action}
        </div>
      </div>
    );
  }
  return (
    <div
      className={cn(
        'grid h-full min-h-80 place-items-center py-10 text-center',
        className,
      )}
    >
      <div className="grid max-w-sm justify-items-center gap-1.5">
        <div className="mb-3 text-faint">{art}</div>
        <h2 className="text-base font-semibold tracking-tight text-ink">
          {title}
        </h2>
        <p className="mb-3 text-sm leading-relaxed text-muted">{children}</p>
        {action}
      </div>
    </div>
  );
}
