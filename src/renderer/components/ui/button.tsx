import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn';
import { Spinner } from './spinner';

export const buttonVariants = cva(
  // aria-disabled fades like disabled but keeps focus; a pending button keeps full strength beside its spinner.
  'inline-flex shrink-0 cursor-default items-center justify-center gap-2 rounded-sm text-sm font-medium whitespace-nowrap transition-colors select-none disabled:pointer-events-none disabled:opacity-50 aria-disabled:not-aria-busy:opacity-50 aria-busy:cursor-progress [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        // Solid fills, no outlines: the label and the fill say "button"; only keyboard focus draws a ring.
        primary: 'bg-accent text-on-accent hover:bg-accent-hover',
        secondary: 'bg-control text-ink hover:bg-control-hover',
        ghost: 'text-muted hover:bg-control hover:text-ink',
        danger:
          'bg-danger-soft text-danger hover:bg-danger hover:text-on-accent',
        link: 'h-auto px-0 text-accent underline-offset-4 hover:underline',
      },
      size: {
        sm: 'h-8 px-3',
        md: 'h-9 px-3.5',
        lg: 'h-11 px-4 text-[0.9375rem]',
        icon: 'size-8',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

type ButtonProps = ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
    pending?: boolean;
  };

// While pending the button stays focusable (no `disabled`) so keyboard focus is not lost; clicks are ignored.
export function Button({
  className,
  variant,
  size,
  asChild,
  type,
  pending = false,
  onClick,
  children,
  'aria-disabled': ariaDisabled,
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot : 'button';
  // The caller's aria-disabled (an unavailable action) and pending both hold; one never hides the other.
  const unavailable = ariaDisabled === true || ariaDisabled === 'true';
  return (
    <Comp
      type={asChild ? undefined : (type ?? 'button')}
      className={cn(buttonVariants({ variant, size }), className)}
      aria-busy={pending || undefined}
      aria-disabled={pending || props.disabled || unavailable || undefined}
      onClick={pending ? (event) => event.preventDefault() : onClick}
      {...props}
    >
      {asChild ? (
        children
      ) : (
        <>
          {pending && <Spinner />}
          {children}
        </>
      )}
    </Comp>
  );
}
