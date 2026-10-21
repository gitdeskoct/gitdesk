import * as Toast from '@radix-ui/react-toast';
import { CircleAlert, CircleCheck, Info, X } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from 'react';
import { cn } from '../../lib/cn';
import { Button } from './button';

type ToastInput = {
  title: string;
  description?: string;
  tone?: 'success' | 'danger' | 'info';
  action?: { label: string; altText: string; onClick: () => void };
  // Results of work the person didn't just ask for are announced politely.
  background?: boolean;
};

const tones = {
  success: { icon: CircleCheck, className: 'text-success' },
  danger: { icon: CircleAlert, className: 'text-danger' },
  info: { icon: Info, className: 'text-muted' },
};

const ToastContext = createContext<((input: ToastInput) => void) | null>(null);

// Short confirmations and failures of actions that close their own UI (menu items, bulk actions).
// Anything that needs a decision stays inline on the page, never in a toast.
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<(ToastInput & { id: number })[]>([]);
  const show = useCallback((input: ToastInput) => {
    // A repeat of the same message replaces the old one instead of stacking.
    setItems((current) => [
      ...current.filter((item) => item.title !== input.title).slice(-2),
      { ...input, id: Date.now() + Math.random() },
    ]);
  }, []);
  const remove = (id: number) =>
    setItems((current) => current.filter((item) => item.id !== id));

  return (
    <ToastContext.Provider value={show}>
      <Toast.Provider swipeDirection="right" label="Notifications">
        {children}
        {items.map((item) => {
          const tone = tones[item.tone ?? 'info'];
          return (
            <Toast.Root
              key={item.id}
              type={item.background ? 'background' : 'foreground'}
              duration={item.tone === 'danger' || item.action ? 8000 : 4000}
              onOpenChange={(open) => !open && remove(item.id)}
              className="flex items-start gap-3 rounded-sm border border-line bg-surface py-3 pr-2 pl-3.5 text-[0.8125rem] shadow-[0_8px_24px_-12px_rgb(0_0_0/0.35)]"
            >
              <tone.icon
                aria-hidden
                className={cn('mt-0.5 size-4 shrink-0', tone.className)}
              />
              <div className="min-w-0 flex-1">
                <Toast.Title className="font-semibold text-ink">
                  {item.title}
                </Toast.Title>
                {item.description && (
                  <Toast.Description className="mt-0.5 leading-relaxed text-muted">
                    {item.description}
                  </Toast.Description>
                )}
                {item.action && (
                  <Toast.Action altText={item.action.altText} asChild>
                    <Button
                      size="sm"
                      className="mt-2"
                      onClick={item.action.onClick}
                    >
                      {item.action.label}
                    </Button>
                  </Toast.Action>
                )}
              </div>
              <Toast.Close asChild>
                <Button variant="ghost" size="icon" aria-label="Dismiss">
                  <X />
                </Button>
              </Toast.Close>
            </Toast.Root>
          );
        })}
        <Toast.Viewport className="fixed right-4 bottom-4 z-50 m-0 flex w-92 max-w-[calc(100vw-2rem)] list-none flex-col gap-2 p-0 outline-none" />
      </Toast.Provider>
    </ToastContext.Provider>
  );
}

export function useToast(): (input: ToastInput) => void {
  const show = useContext(ToastContext);
  if (!show) throw new Error('useToast outside ToastProvider');
  return show;
}
