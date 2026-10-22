import { useState } from 'react';
import type { Settings } from '../../../shared/settings';
import { Button } from '../../components/ui/button';
import { Segmented } from '../../components/ui/segmented';
import { SettingGroup, SettingRow } from '../../components/ui/setting-row';
import { Switch } from '../../components/ui/switch';
import { useToast } from '../../components/ui/toast';
import { ipcErrorMessage } from '../../lib/ipc-error';
import {
  useClearActivity,
  useSettings,
  useTestNotification,
  useUpdateSettings,
} from '../../lib/queries';
import { PageTitle } from '../shell/page';

const LAYOUTS: { value: Settings['dashboardLayout']; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'centered', label: 'Centered' },
  { value: 'split', label: 'Split' },
];

const DENSITIES: { value: Settings['dashboardDensity']; label: string }[] = [
  { value: 'comfortable', label: 'Comfortable' },
  { value: 'compact', label: 'Compact' },
];

// Segmented values are strings; the setting stores minutes.
const INTERVALS = [
  { value: '0', label: 'Off' },
  { value: '5', label: '5 min' },
  { value: '15', label: '15 min' },
  { value: '30', label: '30 min' },
] as const;

const REMOTE: { value: Settings['remoteRefresh']; label: string }[] = [
  { value: 'auto', label: 'Automatic' },
  { value: 'manual', label: 'Manual' },
];

export function WorkspaceSection() {
  const { data: settings } = useSettings();
  const update = useUpdateSettings();
  if (!settings) return null;

  return (
    <>
      <PageTitle title="Workspace">
        How Home and Repositories are laid out, and how often gitdesk checks
        your repositories.
      </PageTitle>
      <SettingGroup title="Home">
        <SettingRow
          id="dashboard-layout"
          label="Layout"
          description="Split adds a column for attention and activity. Auto splits when the window is wide enough."
        >
          <Segmented
            label="Layout"
            value={settings.dashboardLayout}
            options={LAYOUTS}
            onChange={(dashboardLayout) => update.mutate({ dashboardLayout })}
          />
        </SettingRow>
        <SettingRow
          id="dashboard-density"
          label="Density"
          description="Compact rows hide descriptions and fit more repositories."
        >
          <Segmented
            label="Density"
            value={settings.dashboardDensity}
            options={DENSITIES}
            onChange={(dashboardDensity) => update.mutate({ dashboardDensity })}
          />
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="Repositories">
        <SettingRow
          id="repositories-layout"
          label="Layout"
          description="Split keeps the list beside the selected repository. Auto splits when the window is wide enough."
        >
          <Segmented
            label="Repositories layout"
            value={settings.repositoriesLayout}
            options={LAYOUTS}
            onChange={(repositoriesLayout) =>
              update.mutate({ repositoriesLayout })
            }
          />
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="Status checks">
        <SettingRow
          id="watch-repositories"
          label="Watch repositories for changes"
          description="Checks a repository again soon after its branch, index or refs change."
        >
          <Switch
            aria-label="Watch repositories for changes"
            checked={settings.watchRepositories}
            onCheckedChange={(watchRepositories) =>
              update.mutate({ watchRepositories })
            }
          />
        </SettingRow>
        <SettingRow
          id="refresh-on-focus"
          label="Check when gitdesk comes to the front"
          description="Catches edits made in your editor while gitdesk was in the background."
        >
          <Switch
            aria-label="Check when gitdesk comes to the front"
            checked={settings.refreshOnFocus}
            onCheckedChange={(refreshOnFocus) =>
              update.mutate({ refreshOnFocus })
            }
          />
        </SettingRow>
        <SettingRow
          id="background-refresh"
          label="Background check"
          description="Checks every repository on a timer, three at a time. No network access."
        >
          <Segmented
            label="Background check"
            value={
              String(
                settings.backgroundRefresh,
              ) as (typeof INTERVALS)[number]['value']
            }
            options={INTERVALS}
            onChange={(minutes) =>
              update.mutate({
                backgroundRefresh: Number(
                  minutes,
                ) as Settings['backgroundRefresh'],
              })
            }
          />
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="Remote">
        <SettingRow
          id="remote-refresh"
          label="Refresh remote details"
          description="Automatic refreshes at most every 10 minutes. Manual loads only when you ask."
        >
          <Segmented
            label="Refresh remote details"
            value={settings.remoteRefresh}
            options={REMOTE}
            onChange={(remoteRefresh) => update.mutate({ remoteRefresh })}
          />
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="Home sections">
        <SettingRow
          id="home-show-attention"
          label='Show "Needs attention"'
          description="Repositories with changes, conflicts, missing folders or commits to push."
        >
          <Switch
            aria-label='Show "Needs attention"'
            checked={settings.homeShowAttention}
            onCheckedChange={(homeShowAttention) =>
              update.mutate({ homeShowAttention })
            }
          />
        </SettingRow>
        <SettingRow
          id="home-show-activity"
          label='Show "Recent activity"'
          description="Commits, branch switches and remote changes, newest first."
        >
          <Switch
            aria-label='Show "Recent activity"'
            checked={settings.homeShowActivity}
            onCheckedChange={(homeShowActivity) =>
              update.mutate({ homeShowActivity })
            }
          />
        </SettingRow>
        <SettingRow
          id="home-page-size"
          label="Items per page"
          description="For both sections. Pages turn with the arrows under each list."
        >
          <Segmented
            label="Items per page"
            value={
              String(
                settings.homePageSize,
              ) as (typeof PAGE_SIZES)[number]['value']
            }
            options={PAGE_SIZES}
            onChange={(size) =>
              update.mutate({
                homePageSize: Number(size) as Settings['homePageSize'],
              })
            }
          />
        </SettingRow>
      </SettingGroup>
      <ActivityGroup settings={settings} />
      <NotificationGroup settings={settings} />
    </>
  );
}

const PAGE_SIZES = [
  { value: '6', label: '6' },
  { value: '10', label: '10' },
  { value: '20', label: '20' },
] as const;

const SOURCES: { value: Settings['activitySource']; label: string }[] = [
  { value: 'both', label: 'Both' },
  { value: 'local', label: 'This computer' },
  { value: 'account', label: 'Your account' },
];

function ActivityGroup({ settings }: { settings: Settings }) {
  const update = useUpdateSettings();
  const clear = useClearActivity();
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  return (
    <SettingGroup title="Activity">
      <SettingRow
        id="activity-source"
        label="Show activity from"
        description="This computer is commits and branch switches. Your account is remote changes."
      >
        <Segmented
          label="Show activity from"
          value={settings.activitySource}
          options={SOURCES}
          onChange={(activitySource) => update.mutate({ activitySource })}
        />
      </SettingRow>
      <SettingRow
        id="activity-include-opens"
        label="Include opens"
        description="List each time you open a repository. Off keeps the list to real changes."
      >
        <Switch
          aria-label="Include opens"
          checked={settings.activityIncludeOpens}
          onCheckedChange={(activityIncludeOpens) =>
            update.mutate({ activityIncludeOpens })
          }
        />
      </SettingRow>
      <SettingRow
        id="clear-activity"
        stacked={confirming}
        label="Activity on this computer"
        description="Kept locally, up to the last 200 events. Your account's activity is kept by the server."
      >
        {confirming ? (
          <div
            role="group"
            aria-label="Clear activity"
            className="flex flex-wrap items-center gap-3 rounded-sm bg-danger-soft px-3 py-2.5 text-[0.8125rem] text-ink"
          >
            <span className="min-w-0 flex-1">
              Clear the activity list on this computer? Repositories and their
              history are not touched.
            </span>
            <Button
              size="sm"
              variant="danger"
              pending={clear.isPending}
              onClick={() =>
                clear.mutate(undefined, {
                  onSuccess: () => {
                    setConfirming(false);
                    toast({ tone: 'success', title: 'Activity cleared' });
                  },
                  onError: (err) =>
                    toast({
                      tone: 'danger',
                      title: "Activity wasn't cleared",
                      description: ipcErrorMessage(
                        err,
                        'Try again in a moment.',
                      ),
                    }),
                })
              }
            >
              Clear
            </Button>
            <Button
              size="sm"
              variant="ghost"
              autoFocus
              onClick={() => setConfirming(false)}
            >
              Cancel
            </Button>
          </div>
        ) : (
          <Button
            size="sm"
            variant="danger"
            onClick={() => setConfirming(true)}
          >
            Clear…
          </Button>
        )}
      </SettingRow>
    </SettingGroup>
  );
}

const TEST_RESULT = {
  shown:
    'Sent. If nothing appeared, your system is holding gitdesk notifications back.',
  unsupported:
    "This system can't show notifications from gitdesk, so news stays inside the window.",
  off: 'Turn on desktop notifications first.',
} as const;

function NotificationGroup({ settings }: { settings: Settings }) {
  const update = useUpdateSettings();
  const test = useTestNotification();
  const off = !settings.notifications;
  return (
    <SettingGroup title="Notifications">
      <SettingRow
        id="notifications"
        label="Desktop notifications"
        description="Uses your system's notifications. While gitdesk is in front, the same news shows inside the window instead."
      >
        <Switch
          aria-label="Desktop notifications"
          checked={settings.notifications}
          onCheckedChange={(notifications) => update.mutate({ notifications })}
        />
      </SettingRow>
      <SettingRow
        id="notify-clone"
        label="When a clone finishes or fails"
        description="Long clones can run while you work elsewhere."
      >
        <Switch
          aria-label="When a clone finishes or fails"
          checked={settings.notifyClone}
          disabled={off}
          onCheckedChange={(notifyClone) => update.mutate({ notifyClone })}
        />
      </SettingRow>
      <SettingRow
        id="notify-problems"
        label="When a background check finds a conflict or a missing folder"
        description="Once when it appears, not on every check; never for ordinary edits."
      >
        <Switch
          aria-label="When a background check finds a conflict or a missing folder"
          checked={settings.notifyProblems}
          disabled={off}
          onCheckedChange={(notifyProblems) =>
            update.mutate({ notifyProblems })
          }
        />
      </SettingRow>
      <SettingRow
        id="notify-background"
        label="Only while gitdesk is in the background"
        description="Off sends a system notification even when the window is in front."
      >
        <Switch
          aria-label="Only while gitdesk is in the background"
          checked={settings.notifyOnlyInBackground}
          disabled={off}
          onCheckedChange={(notifyOnlyInBackground) =>
            update.mutate({ notifyOnlyInBackground })
          }
        />
      </SettingRow>
      <SettingRow
        id="notify-test"
        label="Test"
        description={
          test.data
            ? TEST_RESULT[test.data]
            : test.isError
              ? ipcErrorMessage(
                  test.error,
                  "The test notification wasn't sent.",
                )
              : 'Sends one notification so you can check your system allows them.'
        }
      >
        <Button
          size="sm"
          pending={test.isPending}
          onClick={() => test.mutate()}
        >
          Send a test
        </Button>
      </SettingRow>
    </SettingGroup>
  );
}
