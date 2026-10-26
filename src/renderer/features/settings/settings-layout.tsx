import {
  AppWindow,
  ArrowDownToLine,
  ArrowLeft,
  Braces,
  Cloud,
  FolderTree,
  GitPullRequest,
  Info,
  Laptop,
  Palette,
  RefreshCw,
  GitCommitHorizontal,
  Keyboard,
  LayoutDashboard,
  Search,
  SlidersHorizontal,
  User,
  type LucideIcon,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { AuthStatus } from '../../../shared/ipc';
import { NoResultsArt } from '../../components/illustrations';
import { Button } from '../../components/ui/button';
import { EmptyState } from '../../components/ui/empty-state';
import { useNavigation, type SettingsSection } from '../../app/navigation';
import { Page } from '../shell/page';
import { NavItem } from '../shell/sidebar';
import { AboutSection } from './about-section';
import { AccountSection } from './account-section';
import { AppearanceSection } from './appearance-section';
import { CodeSection } from './code-section';
import { EditorSection } from './editor-section';
import { FilesSection } from './files-section';
import { DevicesSection } from './devices-section';
import { GeneralSection } from './general-section';
import { GitSection } from './git-section';
import { HostingSection } from './hosting-section';
import { PullsSection } from './pulls-section';
import { SyncSection } from './sync-section';
import { ShortcutsSection } from './shortcuts-section';
import { UpdatesSection } from './updates-section';
import { WorkspaceSection } from './workspace-section';
import { SECTION_LABELS, searchSettings } from './search-index';

const GROUPS: {
  label: string;
  items: { id: SettingsSection; icon: LucideIcon }[];
}[] = [
  {
    label: 'App',
    items: [
      { id: 'general', icon: SlidersHorizontal },
      { id: 'appearance', icon: Palette },
      { id: 'code', icon: Braces },
      { id: 'workspace', icon: LayoutDashboard },
      { id: 'files', icon: FolderTree },
      { id: 'pulls', icon: GitPullRequest },
      { id: 'sync', icon: RefreshCw },
      { id: 'editor', icon: AppWindow },
      { id: 'git', icon: GitCommitHorizontal },
      { id: 'shortcuts', icon: Keyboard },
    ],
  },
  {
    label: 'Account',
    items: [
      { id: 'account', icon: User },
      { id: 'hosting', icon: Cloud },
      { id: 'devices', icon: Laptop },
    ],
  },
  {
    label: 'gitdesk',
    items: [
      { id: 'updates', icon: ArrowDownToLine },
      { id: 'about', icon: Info },
    ],
  },
];

function SearchResults({
  query,
  onClear,
}: {
  query: string;
  onClear: () => void;
}) {
  const { navigate } = useNavigation();
  const results = searchSettings(query);
  if (!results.length) {
    return (
      <EmptyState
        art={<NoResultsArt />}
        title={`No settings match "${query}"`}
        action={<Button onClick={onClear}>Clear search</Button>}
      >
        Try a shorter word, like "git" or "theme".
      </EmptyState>
    );
  }
  return (
    <ul className="divide-y divide-line border-y border-line">
      {results.map((entry) => (
        <li key={entry.id}>
          <button
            type="button"
            className="flex w-full items-center justify-between gap-6 py-3.5 text-left hover:bg-row-hover"
            onClick={() => {
              onClear();
              navigate({
                name: 'settings',
                section: entry.section,
                row: entry.id,
              });
            }}
          >
            <span className="text-sm font-medium text-ink">{entry.label}</span>
            <span className="text-[0.8125rem] text-muted">
              {SECTION_LABELS[entry.section]}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function SettingsLayout({
  status,
  section,
}: {
  status: AuthStatus;
  section: SettingsSection;
}) {
  const { navigate } = useNavigation();
  const [query, setQuery] = useState('');
  const searching = query.trim().length > 0;

  const sections: Record<SettingsSection, ReactNode> = {
    general: <GeneralSection />,
    appearance: <AppearanceSection />,
    code: <CodeSection />,
    workspace: <WorkspaceSection />,
    files: <FilesSection />,
    pulls: <PullsSection />,
    sync: <SyncSection />,
    editor: <EditorSection />,
    git: <GitSection />,
    shortcuts: <ShortcutsSection />,
    account: <AccountSection status={status} />,
    hosting: <HostingSection status={status} />,
    devices: <DevicesSection status={status} />,
    updates: <UpdatesSection />,
    about: <AboutSection />,
  };

  return (
    <>
      <nav
        aria-label="Settings"
        className="flex w-58 flex-none flex-col gap-0.5 overflow-y-auto px-2.5 pt-3 pb-2.5"
      >
        <NavItem
          label="Back to app"
          icon={ArrowLeft}
          active={false}
          collapsed={false}
          onSelect={() => navigate({ name: 'home' })}
        />
        <label className="field mt-2 mb-0.5 flex h-8 items-center gap-2 px-2.5 text-muted">
          <Search className="size-4 shrink-0" aria-hidden />
          <span className="sr-only">Search settings</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => event.key === 'Escape' && setQuery('')}
            placeholder="Search settings"
            className="min-w-0 flex-1 bg-transparent text-[0.8125rem] text-ink outline-none placeholder:text-muted"
          />
        </label>
        {GROUPS.map((group) => (
          <div key={group.label} className="contents">
            <div className="px-2.5 pt-3.5 pb-1 text-xs font-medium text-muted">
              {group.label}
            </div>
            {group.items.map((item) => (
              <NavItem
                key={item.id}
                label={SECTION_LABELS[item.id]}
                icon={item.icon}
                active={!searching && section === item.id}
                collapsed={false}
                onSelect={() => {
                  setQuery('');
                  navigate({ name: 'settings', section: item.id });
                }}
              />
            ))}
          </div>
        ))}
      </nav>
      <Page
        // The release notes and install steps sit side by side, so Updates gets the wider column.
        width={section === 'updates' && !searching ? 'page' : 'narrow'}
        crumbs={[
          {
            label: 'Settings',
            onSelect: () => {
              setQuery('');
              navigate({ name: 'settings', section: 'general' });
            },
          },
          { label: searching ? 'Search' : SECTION_LABELS[section] },
        ]}
      >
        {searching ? (
          <SearchResults query={query.trim()} onClear={() => setQuery('')} />
        ) : (
          sections[section]
        )}
      </Page>
    </>
  );
}
