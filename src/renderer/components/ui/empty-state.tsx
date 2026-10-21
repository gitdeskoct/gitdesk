import type { ReactNode } from 'react';

// One drawing, one sentence, one action. Fills the workspace body so it sits in the optical center.
export function EmptyState({
  art,
  title,
  children,
  action,
}: {
  art: ReactNode;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="grid h-full min-h-80 place-items-center py-10 text-center">
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
