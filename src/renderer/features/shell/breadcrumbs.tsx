import { ChevronRight } from 'lucide-react';
import { Fragment } from 'react';

export type Crumb = { label: string; onSelect?: () => void };

export function Breadcrumbs({ items }: { items: Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
      <ol className="flex items-center gap-1.5 text-[0.8125rem] text-muted">
        {items.map((item, index) => {
          const last = index === items.length - 1;
          return (
            <Fragment key={item.label}>
              <li className="min-w-0 truncate">
                {last ? (
                  <span aria-current="page" className="font-semibold text-ink">
                    {item.label}
                  </span>
                ) : item.onSelect ? (
                  <button
                    type="button"
                    onClick={item.onSelect}
                    className="rounded-sm hover:text-ink"
                  >
                    {item.label}
                  </button>
                ) : (
                  item.label
                )}
              </li>
              {!last && (
                <li aria-hidden className="flex">
                  <ChevronRight className="size-3.5" />
                </li>
              )}
            </Fragment>
          );
        })}
      </ol>
    </nav>
  );
}
