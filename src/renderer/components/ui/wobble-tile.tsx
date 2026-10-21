import { useRef, type MouseEvent, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { useMotionAllowed } from '../../lib/queries';

// Adapted from Aceternity's WobbleCard: the tile follows the pointer and its content counter-moves.
// The original's radial gradient, noise texture and shadows are dropped; the tile is one solid token color.
export function WobbleTile({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  const outer = useRef<HTMLElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const allowed = useMotionAllowed();

  // Writes styles directly instead of through state: pointer moves would otherwise re-render on every frame.
  const move = (event: MouseEvent<HTMLElement>) => {
    if (!allowed || !outer.current || !inner.current) return;
    const rect = outer.current.getBoundingClientRect();
    const x = (event.clientX - (rect.left + rect.width / 2)) / 20;
    const y = (event.clientY - (rect.top + rect.height / 2)) / 20;
    outer.current.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    inner.current.style.transform = `translate3d(${-x}px, ${-y}px, 0) scale3d(1.03, 1.03, 1)`;
  };
  const reset = () => {
    if (outer.current) outer.current.style.transform = '';
    if (inner.current) inner.current.style.transform = '';
  };

  return (
    <section
      ref={outer}
      onMouseMove={move}
      onMouseLeave={reset}
      className={cn(
        'relative overflow-hidden rounded-sm transition-transform duration-100 ease-out',
        className,
      )}
    >
      <div
        ref={inner}
        className="relative h-full px-6.5 py-6 transition-transform duration-100 ease-out"
      >
        {children}
      </div>
    </section>
  );
}
