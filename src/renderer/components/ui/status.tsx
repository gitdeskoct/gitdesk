import {
  CircleAlert,
  CircleCheck,
  Info,
  LoaderCircle,
  TriangleAlert,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

const tones = {
  info: { icon: Info, className: 'text-muted' },
  success: { icon: CircleCheck, className: 'text-success' },
  warning: { icon: TriangleAlert, className: 'text-warning' },
  danger: { icon: CircleAlert, className: 'text-danger' },
};

// Icon plus text, never color alone, so the meaning survives color blindness and forced colors.
export function InlineStatus({
  tone = 'info',
  children,
  action,
  className,
}: {
  tone?: keyof typeof tones;
  children: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  const { icon: Icon, className: toneClass } = tones[tone];
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cn('flex items-start gap-2 text-sm', className)}
    >
      <Icon aria-hidden className={cn('mt-0.5 size-4 shrink-0', toneClass)} />
      <div className="min-w-0 flex-1 text-ink">{children}</div>
      {action}
    </div>
  );
}

export function Loading({ label }: { label: string }) {
  return (
    <div
      role="status"
      className="flex items-center gap-2 py-4 text-sm text-muted"
    >
      <LoaderCircle aria-hidden className="size-4 animate-spin" />
      {label}
    </div>
  );
}
