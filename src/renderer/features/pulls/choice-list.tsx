import * as RadioGroup from '@radix-ui/react-radio-group';
import type { ReactNode } from 'react';

// A vertical list of choices with a sentence each: merge methods, revert sides, destinations.
export function ChoiceList<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: { value: T; title: ReactNode; description: ReactNode }[];
}) {
  return (
    <RadioGroup.Root
      aria-label={label}
      value={value}
      onValueChange={(next) => onChange(next as T)}
      className="border-t border-line"
    >
      {options.map((option) => (
        <label
          key={option.value}
          className="flex cursor-pointer items-start gap-3 border-b border-line py-2.5"
        >
          <RadioGroup.Item
            value={option.value}
            className="mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border border-faint bg-field data-[state=checked]:border-accent"
          >
            <RadioGroup.Indicator className="size-2 rounded-full bg-accent" />
          </RadioGroup.Item>
          <span className="min-w-0 text-[0.8125rem]">
            <span className="block font-medium text-ink">{option.title}</span>
            <span className="block text-muted">{option.description}</span>
          </span>
        </label>
      ))}
    </RadioGroup.Root>
  );
}
