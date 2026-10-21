import * as Label from '@radix-ui/react-label';
import { useId, type ComponentProps } from 'react';
import { cn } from '../../lib/cn';

export function TextField({
  label,
  error,
  className,
  ...props
}: ComponentProps<'input'> & { label: string; error?: string }) {
  const id = useId();
  return (
    <div className={cn('grid gap-1.5', className)}>
      <Label.Root htmlFor={id} className="text-sm font-medium text-ink">
        {label}
      </Label.Root>
      <input
        id={id}
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-error` : undefined}
        className="h-9 rounded-sm border border-faint bg-surface px-3 text-sm text-ink placeholder:text-muted aria-invalid:border-danger"
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
