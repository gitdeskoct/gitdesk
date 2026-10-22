import { Copy } from 'lucide-react';
import { useState } from 'react';
import { cn } from '../../lib/cn';
import { Button } from './button';
import { useToast } from './toast';
import { Tooltip } from './tooltip';

// Splits before the last segment so a long path or URL loses its middle, never its name.
export function splitTail(value: string) {
  const end = /[\\/]+$/.exec(value)?.index ?? value.length;
  const cut = Math.max(
    value.lastIndexOf('/', end - 1),
    value.lastIndexOf('\\', end - 1),
  );
  return cut <= 0
    ? { head: '', tail: value }
    : { head: value.slice(0, cut), tail: value.slice(cut) };
}

// The start shortens with an ellipsis and the last segment stays whole; the full value is in
// the tooltip and the screen reader text.
export function MiddleTruncate({
  value,
  className,
}: {
  value: string;
  className?: string;
}) {
  const { head, tail } = splitTail(value);
  return (
    <span className={cn('flex min-w-0', className)} title={value}>
      <span className="sr-only">{value}</span>
      <span aria-hidden className="min-w-0 truncate">
        {head}
      </span>
      <span aria-hidden className="max-w-full shrink-0 truncate">
        {tail}
      </span>
    </span>
  );
}

// A path or URL with a copy button that copies all of it. `label` is a noun as it reads mid-
// sentence ("path"). `copy` replaces the clipboard write when main holds the real value (a folder
// shown as ~/…).
export function LongValue({
  value,
  label,
  copy,
  className,
}: {
  value: string;
  label: string;
  copy?: () => Promise<void>;
  className?: string;
}) {
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const run = () => {
    setPending(true);
    (copy ? copy() : navigator.clipboard.writeText(value))
      .then(
        () =>
          toast({
            tone: 'success',
            title: `${label.charAt(0).toUpperCase()}${label.slice(1)} copied`,
          }),
        () =>
          toast({
            tone: 'danger',
            title: `Couldn't copy the ${label}`,
          }),
      )
      .finally(() => setPending(false));
  };
  return (
    <span className={cn('flex min-w-0 items-center gap-1', className)}>
      <MiddleTruncate value={value} className="font-mono" />
      <Tooltip label={`Copy ${label}`} side="top">
        <Button
          size="icon"
          variant="ghost"
          className="size-6 [&_svg]:size-3.5"
          aria-label={`Copy ${label}`}
          pending={pending}
          onClick={run}
        >
          {!pending && <Copy />}
        </Button>
      </Tooltip>
    </span>
  );
}
