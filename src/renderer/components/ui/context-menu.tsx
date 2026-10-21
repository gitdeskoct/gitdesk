import * as Menu from '@radix-ui/react-context-menu';
import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn';

// Non-modal for the same reason as DropdownMenu: the modal scroll lock injects a <style> tag the
// production CSP blocks. Every item here also exists in a keyboard-reachable overflow menu.
export const ContextMenu = (props: ComponentProps<typeof Menu.Root>) => (
  <Menu.Root modal={false} {...props} />
);
export const ContextMenuTrigger = Menu.Trigger;

export function ContextMenuContent({
  className,
  ...props
}: ComponentProps<typeof Menu.Content>) {
  return (
    <Menu.Portal>
      <Menu.Content
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

export function ContextMenuItem({
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

export function ContextMenuSeparator() {
  return <Menu.Separator className="my-1.5 h-px bg-line" />;
}
