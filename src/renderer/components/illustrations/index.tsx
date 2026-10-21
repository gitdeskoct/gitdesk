import type { ReactNode, SVGProps } from 'react';

// Line drawings in currentColor (text-faint from EmptyState) with one accent node each.
// Every drawing shows the Git or app concept its page is about.
function Art({
  children,
  viewBox,
  width,
  height,
  strokeWidth = 1.3,
  ...props
}: SVGProps<SVGSVGElement> & { children: ReactNode }) {
  return (
    <svg
      viewBox={viewBox}
      width={width}
      height={height}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...props}
    >
      {children}
    </svg>
  );
}

const accent = { stroke: 'var(--accent)' };

export const RepositoriesArt = () => (
  <Art viewBox="0 0 88 72" width={120} height={96}>
    <path d="M6 16a6 6 0 0 1 6-6h18l6 6h40a6 6 0 0 1 6 6v38a6 6 0 0 1-6 6H12a6 6 0 0 1-6-6V16z" />
    <circle cx="30" cy="36" r="3.5" />
    <circle cx="30" cy="54" r="3.5" />
    <circle cx="52" cy="42" r="3.5" {...accent} />
    <path d="M30 39.5v11M52 45.5v1.5a6 6 0 0 1-6 6H33.5M60 36h12M60 48h8" />
  </Art>
);

export const IssuesArt = () => (
  <Art viewBox="0 0 88 72" width={120} height={96}>
    <circle cx="26" cy="28" r="16" />
    <circle cx="26" cy="28" r="4" {...accent} />
    <path d="M52 18h28M52 28h22M52 38h28M8 58h72" />
  </Art>
);

export const PullRequestsArt = () => (
  <Art viewBox="0 0 88 72" width={120} height={96}>
    <circle cx="24" cy="14" r="5" />
    <circle cx="24" cy="58" r="5" />
    <circle cx="64" cy="58" r="5" {...accent} />
    <path d="M24 19v34M64 53V30a8 8 0 0 0-8-8H42" />
    <path d="m48 15-7 7 7 7" />
  </Art>
);

export const DevicesArt = () => (
  <Art viewBox="0 0 64 52" width={88} height={72} strokeWidth={1.4}>
    <rect x="10" y="8" width="44" height="28" rx="6" />
    <path d="M4 44h56" />
    <path d="m25 22 5 5 9-10" {...accent} />
  </Art>
);

export const OfflineArt = () => (
  <Art viewBox="0 0 64 52" width={120} height={96} strokeWidth={1.1}>
    <path d="M18 38h28a10 10 0 0 0 1-20 14 14 0 0 0-27-2 11 11 0 0 0-2 22z" />
    <path d="M12 46 52 8" {...accent} />
  </Art>
);

export const GitMissingArt = () => (
  <Art viewBox="0 0 64 52" width={120} height={96} strokeWidth={1.1}>
    <circle cx="18" cy="10" r="4" />
    <circle cx="18" cy="42" r="4" strokeDasharray="2 3" />
    <path d="M18 14v8" />
    <path d="M18 26v12" strokeDasharray="2 3" />
    <path
      d="M36 18a6 6 0 1 1 8 5.6c-1.3.5-2 1.6-2 3V29M42 35v.01"
      {...accent}
    />
  </Art>
);

export const NoResultsArt = () => (
  <Art viewBox="0 0 64 52" width={104} height={84} strokeWidth={1.2}>
    <path d="M6 10h34M6 20h26M6 30h20" />
    <circle cx="44" cy="32" r="9" {...accent} />
    <path d="m51 39 7 7" {...accent} />
  </Art>
);

export const FolderMissingArt = () => (
  <Art viewBox="0 0 88 72" width={120} height={96}>
    <path
      d="M6 16a6 6 0 0 1 6-6h18l6 6h40a6 6 0 0 1 6 6v38a6 6 0 0 1-6 6H12a6 6 0 0 1-6-6V16z"
      strokeDasharray="3 4"
    />
    <circle cx="44" cy="40" r="10" {...accent} />
    <path d="m40 36 8 8M48 36l-8 8" {...accent} />
  </Art>
);

export const ActivityArt = () => (
  <Art viewBox="0 0 64 52" width={88} height={72} strokeWidth={1.4}>
    <circle cx="14" cy="26" r="5" />
    <path d="M19 26h24" />
    <circle cx="48" cy="26" r="5" {...accent} />
    <path d="M8 44h48" strokeDasharray="2 4" />
  </Art>
);

export const RemoteArt = () => (
  <Art viewBox="0 0 64 52" width={120} height={96} strokeWidth={1.1}>
    <path d="M18 34h28a10 10 0 0 0 1-20 14 14 0 0 0-27-2 11 11 0 0 0-2 22z" />
    <path d="M32 34v10M24 46h16" />
    <circle cx="32" cy="22" r="3.5" {...accent} />
  </Art>
);

// Bleeding drawings for the sign-in tiles: larger, on a solid tile color.
export const CommitGraphArt = ({ className }: { className?: string }) => (
  <Art
    viewBox="0 0 190 130"
    width={300}
    height={200}
    strokeWidth={2}
    className={className}
  >
    <path d="M30 10v120" />
    <circle cx="30" cy="30" r="7" fill="var(--accent)" />
    <circle cx="30" cy="70" r="7" fill="var(--accent)" />
    <circle cx="30" cy="110" r="7" fill="var(--accent)" />
    <path d="M30 77c0 18 20 18 40 18h40c14 0 22-8 22-22V48" />
    <circle cx="132" cy="40" r="7" fill="var(--accent)" />
    <path d="M132 33V0M60 30h50M150 40h40" />
  </Art>
);

export const BrowserLockArt = ({ className }: { className?: string }) => (
  <Art
    viewBox="0 0 90 90"
    width={120}
    height={120}
    strokeWidth={2}
    className={className}
  >
    <rect x="10" y="38" width="62" height="46" rx="6" />
    <path d="M24 38V26a17 17 0 0 1 34 0v12" />
    <circle cx="41" cy="58" r="5" />
    <path d="M41 63v8" />
  </Art>
);

export const KeychainArt = ({ className }: { className?: string }) => (
  <Art
    viewBox="0 0 96 84"
    width={128}
    height={112}
    strokeWidth={2}
    className={className}
  >
    <rect x="8" y="10" width="64" height="42" rx="6" />
    <path d="M2 62h76" />
    <rect x="58" y="34" width="34" height="46" rx="6" fill="var(--sunken)" />
    <path d="m68 56 5 5 10-11" {...accent} />
  </Art>
);
