import * as SwitchPrimitive from '@radix-ui/react-switch';
import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn';

// The off track is solid --faint, so the control clears 3:1 non-text contrast without an outline.
export function Switch({
  className,
  ...props
}: ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        'inline-flex h-5 w-9 shrink-0 items-center rounded-sm bg-faint p-[3px] transition-colors disabled:opacity-50 data-[state=checked]:bg-accent',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="size-3.5 rounded-[4px] bg-surface transition-transform data-[state=checked]:translate-x-4 data-[state=checked]:bg-on-accent" />
    </SwitchPrimitive.Root>
  );
}
