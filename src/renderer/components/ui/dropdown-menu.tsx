import * as Menu from '@radix-ui/react-dropdown-menu';
import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn';

// Non-modal: the modal scroll lock injects a <style> tag that the production CSP blocks.
export const DropdownMenu = (props: ComponentProps<typeof Menu.Root>) => (
  <Menu.Root modal={false} {...props} />
);
export const DropdownMenuTrigger = Menu.Trigger;

// The menu floats above the page, so it is the one place a shadow marks real elevation.
export function DropdownMenuContent({
  className,
  ...props
}: ComponentProps<typeof Menu.Content>) {
  return (
    <Menu.Portal>
      <Menu.Content
        sideOffset={6}
        collisionPadding={8}
        className={cn(
          'z-50 min-w-56 rounded-sm border border-line bg-surface p-1.5 text-sm shadow-[0_8px_24px_-12px_rgb(0_0_0/0.35)]',
          className,
        )}
        {...props}
      />
    </Menu.Portal>
  );
}

export function DropdownMenuItem({
  className,
  ...props
}: ComponentProps<typeof Menu.Item>) {
  return (
    <Menu.Item
      className={cn(
        'flex h-8 cursor-default items-center gap-2.5 rounded-sm px-2 text-ink outline-none select-none data-[disabled]:opacity-50 data-[highlighted]:bg-control [&_svg]:size-4 [&_svg]:text-muted',
        className,
      )}
      {...props}
    />
  );
}

export function DropdownMenuSeparator() {
  return <Menu.Separator className="my-1.5 h-px bg-line" />;
}

export const DropdownMenuLabel = ({
  className,
  ...props
}: ComponentProps<typeof Menu.Label>) => (
  <Menu.Label className={cn('px-2 py-1.5', className)} {...props} />
);
