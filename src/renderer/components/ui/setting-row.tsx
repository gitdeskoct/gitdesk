import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

// Cardless group: rows separated by hairlines, label left, control right.
export function SettingGroup({
  title,
  children,
}: {
  title?: string;
  children: ReactNode;
}) {
  return (
    <section className="mt-9 first:mt-0">
      {title && (
        <h2 className="mb-1 text-[0.8125rem] font-medium text-muted">
          {title}
        </h2>
      )}
      <div className="divide-y divide-line border-y border-line">
        {children}
      </div>
    </section>
  );
}

export function SettingRow({
  id,
  label,
  description,
  children,
  stacked,
}: {
  id?: string;
  label: string;
  description?: ReactNode;
  children?: ReactNode;
  stacked?: boolean;
}) {
  return (
    <div
      id={id}
      className={cn(
        'scroll-mt-6 py-4 target:bg-accent-soft',
        stacked
          ? 'grid gap-3'
          : 'flex flex-wrap items-center justify-between gap-x-8 gap-y-3',
      )}
    >
      <div className="max-w-md min-w-0">
        <div className="text-sm font-medium text-ink">{label}</div>
        {description && (
          <div className="mt-0.5 text-sm text-muted">{description}</div>
        )}
      </div>
      {children}
    </div>
  );
}
