import * as Label from '@radix-ui/react-label';
import { useId, type ComponentProps } from 'react';
import { cn } from '../../lib/cn';

export function TextField({
  label,
  hideLabel,
  error,
  hint,
  className,
  ...props
}: ComponentProps<'input'> & {
  label: string;
  hideLabel?: boolean;
  error?: string;
  hint?: string;
}) {
  const id = useId();
  const describedBy =
    [error && `${id}-error`, hint && `${id}-hint`].filter(Boolean).join(' ') ||
    undefined;
  return (
    <div className={cn('grid gap-1.5', className)}>
      <Label.Root
        htmlFor={id}
        className={cn('text-sm font-medium text-ink', hideLabel && 'sr-only')}
      >
        {label}
      </Label.Root>
      <input
        id={id}
        aria-invalid={!!error}
        aria-describedby={describedBy}
        className="field h-9 w-full min-w-0 px-3 text-sm placeholder:text-muted"
        {...props}
      />
      {hint && !error && (
        <p id={`${id}-hint`} className="text-[0.8125rem] text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
