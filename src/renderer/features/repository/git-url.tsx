import { LongValue } from '../../components/ui/long-value';

// The hosted Git URL holds no credentials, so it can be shown and copied freely.
export function GitUrlField({ url }: { url: string }) {
  return (
    <div className="flex h-8.5 min-w-0 items-center rounded-sm border border-line bg-sunken pr-0.5 pl-2.5">
      <LongValue
        value={url}
        label="Git URL"
        className="flex-1 justify-between text-[0.78125rem] text-ink"
      />
    </div>
  );
}
