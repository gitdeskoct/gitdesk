import * as SwitchPrimitive from '@radix-ui/react-switch';
import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn';

// Off-state track uses --faint so the control boundary clears 3:1 non-text contrast.
export function Switch({
  className,
  ...props
}: ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        'inline-flex h-5 w-9 shrink-0 items-center rounded-sm border border-faint bg-sunken p-0.5 transition-colors data-[state=checked]:border-accent data-[state=checked]:bg-accent',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="size-3.5 rounded-[4px] bg-faint transition-transform data-[state=checked]:translate-x-4 data-[state=checked]:bg-on-accent" />
    </SwitchPrimitive.Root>
  );
}
