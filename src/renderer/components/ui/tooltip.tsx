import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import type { ReactNode } from 'react';

export const TooltipProvider = TooltipPrimitive.Provider;

export function Tooltip({
  label,
  side = 'right',
  disabled,
  children,
}: {
  label: string;
  side?: 'top' | 'right' | 'bottom' | 'left';
  disabled?: boolean;
  children: ReactNode;
}) {
  if (disabled) return children;
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={8}
          className="z-50 rounded-sm bg-ink px-2 py-1 text-xs font-medium text-canvas"
        >
          {label}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
