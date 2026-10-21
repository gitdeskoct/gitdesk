import * as Label from '@radix-ui/react-label';
import { useId, type ComponentProps } from 'react';
import { cn } from '../../lib/cn';

export function TextField({
  label,
  hideLabel,
  error,
  className,
  ...props
}: ComponentProps<'input'> & {
  label: string;
  hideLabel?: boolean;
  error?: string;
}) {
  const id = useId();
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
        aria-describedby={error ? `${id}-error` : undefined}
        className="h-9 w-full min-w-0 rounded-sm border border-faint bg-surface px-3 text-sm text-ink placeholder:text-muted aria-invalid:border-danger"
        {...props}
      />
      {error && (
        <p id={`${id}-error`} className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
