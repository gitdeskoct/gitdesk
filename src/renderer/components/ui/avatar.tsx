import * as AvatarPrimitive from '@radix-ui/react-avatar';
import { cn } from '../../lib/cn';

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('') || '?';

export function Avatar({
  name,
  src,
  className,
}: {
  name: string;
  src?: string | null;
  className?: string;
}) {
  return (
    <AvatarPrimitive.Root
      className={cn(
        'inline-flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-sm bg-accent-soft',
        className,
      )}
    >
      {src && (
        <AvatarPrimitive.Image
          src={src}
          alt=""
          referrerPolicy="no-referrer"
          className="size-full object-cover"
        />
      )}
      <AvatarPrimitive.Fallback className="text-[0.6875rem] font-semibold text-accent">
        {initials(name)}
      </AvatarPrimitive.Fallback>
    </AvatarPrimitive.Root>
  );
}
