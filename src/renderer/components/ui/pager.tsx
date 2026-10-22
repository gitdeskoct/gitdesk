import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useState } from 'react';
import { cn } from '../../lib/cn';

// Page numbers to draw: all of them up to five, otherwise first, last and the current
// neighbourhood, with null standing for the gap.
export function pageList(page: number, pages: number): (number | null)[] {
  if (pages <= 5) return Array.from({ length: pages }, (_, i) => i + 1);
  const near = [page - 1, page, page + 1].filter((p) => p > 1 && p < pages);
  const list: (number | null)[] = [1];
  if (near[0]! > 2) list.push(null);
  list.push(...near);
  if (near[near.length - 1]! < pages - 1) list.push(null);
  list.push(pages);
  return list;
}

// Slices a list into pages and keeps the page in range when the list shrinks under it.
export function usePage<T>(items: T[], size: number) {
  const [page, setPage] = useState(1);
  const pages = Math.max(1, Math.ceil(items.length / size));
  useEffect(() => {
    if (page > pages) setPage(pages);
  }, [page, pages]);
  const current = Math.min(page, pages);
  return {
    page: current,
    pages,
    setPage,
    items: items.slice((current - 1) * size, current * size),
    from: items.length ? (current - 1) * size + 1 : 0,
    to: Math.min(current * size, items.length),
    total: items.length,
  };
}

// Count on the left, pages on the right. Hidden when everything fits on one page.
export function Pager({
  label,
  page,
  pages,
  from,
  to,
  total,
  onPage,
}: {
  label: string;
  page: number;
  pages: number;
  from: number;
  to: number;
  total: number;
  onPage: (page: number) => void;
}) {
  if (pages <= 1) return null;
  const go = (next: number) => onPage(Math.min(pages, Math.max(1, next)));
  const button =
    'grid h-7 min-w-7 place-items-center rounded-sm px-1.5 text-[0.78125rem] text-muted transition-colors hover:bg-control hover:text-ink aria-disabled:opacity-50 aria-disabled:hover:bg-transparent focus-visible:outline-offset-0';
  return (
    <nav
      aria-label={label}
      className="flex items-center justify-between gap-3 pt-2.5 text-xs text-muted"
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft') go(page - 1);
        if (event.key === 'ArrowRight') go(page + 1);
      }}
    >
      <span aria-live="polite" className="tabular-nums">
        {from}–{to} of {total}
      </span>
      <div className="flex items-center gap-0.5">
        <button
          type="button"
          aria-label="Previous page"
          aria-disabled={page === 1 || undefined}
          onClick={() => go(page - 1)}
          className={button}
        >
          <ChevronLeft aria-hidden className="size-3.5" />
        </button>
        {pageList(page, pages).map((p, index) =>
          p === null ? (
            <span key={`gap-${index}`} aria-hidden className="px-1">
              …
            </span>
          ) : (
            <button
              key={p}
              type="button"
              aria-label={`Page ${p}`}
              aria-current={p === page ? 'page' : undefined}
              onClick={() => go(p)}
              className={cn(
                button,
                'tabular-nums',
                p === page && 'bg-control font-semibold text-ink',
              )}
            >
              {p}
            </button>
          ),
        )}
        <button
          type="button"
          aria-label="Next page"
          aria-disabled={page === pages || undefined}
          onClick={() => go(page + 1)}
          className={button}
        >
          <ChevronRight aria-hidden className="size-3.5" />
        </button>
      </div>
    </nav>
  );
}
