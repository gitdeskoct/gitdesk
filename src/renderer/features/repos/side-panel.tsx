import { motion } from 'framer-motion';
import { X } from 'lucide-react';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Button } from '../../components/ui/button';
import { Tooltip } from '../../components/ui/tooltip';

// A non-modal panel docked to the right of the page body: the page stays readable and usable
// beside it, and Escape or the close button puts it away. Focus moves in when it opens.
export function SidePanel({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const id = useId();
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('input, button:not([data-close])')?.focus();
  }, []);

  return (
    <motion.aside
      ref={ref}
      aria-labelledby={id}
      initial={{ opacity: 0, x: 16 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.16, ease: 'easeOut' }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
      }}
      className="flex w-[min(420px,45%)] min-w-80 flex-none flex-col border-l border-line bg-surface"
    >
      <div className="flex h-13 flex-none items-center justify-between border-b border-line pr-3 pl-6">
        <h2 id={id} className="text-[0.9375rem] font-semibold text-ink">
          {title}
        </h2>
        <Tooltip label="Close" side="bottom">
          <Button
            variant="ghost"
            size="icon"
            data-close
            aria-label="Close panel"
            onClick={onClose}
          >
            <X />
          </Button>
        </Tooltip>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-6 py-5">{children}</div>
    </motion.aside>
  );
}
