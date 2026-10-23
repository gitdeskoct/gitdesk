import { Copy } from 'lucide-react';
import { useState } from 'react';
import { Button } from './button';
import { useToast } from './toast';
import { Tooltip } from './tooltip';

// Copies a value and says so in a toast; the icon becomes a spinner while the clipboard answers.
export function CopyButton({
  value,
  label,
  text,
}: {
  value: string;
  // A noun as it reads mid-sentence: "commit hash", "branch name".
  label: string;
  // Shown beside the icon; without it the button is icon-only with a tooltip.
  text?: string;
}) {
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const run = () => {
    setPending(true);
    navigator.clipboard
      .writeText(value)
      .then(
        () =>
          toast({
            tone: 'success',
            title: `${label.charAt(0).toUpperCase()}${label.slice(1)} copied`,
          }),
        () => toast({ tone: 'danger', title: `Couldn't copy the ${label}` }),
      )
      .finally(() => setPending(false));
  };
  const button = (
    <Button
      size={text ? 'sm' : 'icon'}
      variant="ghost"
      aria-label={text ? undefined : `Copy ${label}`}
      pending={pending}
      onClick={run}
    >
      {!pending && <Copy />}
      {text}
    </Button>
  );
  return text ? (
    button
  ) : (
    <Tooltip label={`Copy ${label}`} side="top">
      {button}
    </Tooltip>
  );
}
