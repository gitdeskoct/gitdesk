import { Copy } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Tooltip } from '../../components/ui/tooltip';
import { useToast } from '../../components/ui/toast';

// The hosted Git URL holds no credentials, so it can be shown and copied freely.
export function GitUrlField({ url }: { url: string }) {
  const toast = useToast();
  return (
    <div className="flex h-8.5 min-w-0 items-center gap-2 rounded-sm border border-line bg-sunken pr-0.5 pl-2.5">
      <span
        className="min-w-0 flex-1 truncate font-mono text-[0.78125rem] text-ink"
        title={url}
      >
        {url}
      </span>
      <Tooltip label="Copy Git URL" side="top">
        <Button
          size="icon"
          variant="ghost"
          aria-label="Copy Git URL"
          onClick={() =>
            void navigator.clipboard.writeText(url).then(
              () => toast({ tone: 'success', title: 'Git URL copied' }),
              () => toast({ tone: 'danger', title: "Couldn't copy the URL" }),
            )
          }
        >
          <Copy />
        </Button>
      </Tooltip>
    </div>
  );
}
