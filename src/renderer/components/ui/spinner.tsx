import { cn } from '../../lib/cn';

// Decorative: the busy state is announced by the control that owns it (aria-busy plus its label).
export function Spinner({ className }: { className?: string }) {
  return (
    <svg
      data-spinner
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden
      className={cn(
        'size-4 shrink-0 animate-[spin_0.8s_linear_infinite]',
        className,
      )}
    >
      <circle
        cx="8"
        cy="8"
        r="6"
        stroke="currentColor"
        strokeOpacity="0.3"
        strokeWidth="2"
      />
      <path
        d="M14 8a6 6 0 0 0-6-6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}
