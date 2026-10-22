import type { Settings } from '../../../shared/settings';
import { Button } from '../../components/ui/button';
import { Segmented } from '../../components/ui/segmented';
import { SettingGroup, SettingRow } from '../../components/ui/setting-row';
import { Switch } from '../../components/ui/switch';
import { useSettings, useUpdateSettings } from '../../lib/queries';
import { useNavigation } from '../../app/navigation';
import { PageTitle } from '../shell/page';

const LAYOUTS: { value: Settings['pullRequestsLayout']; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'centered', label: 'Centered' },
  { value: 'split', label: 'Split' },
];

const METHODS: { value: Settings['pullMergeMethod']; label: string }[] = [
  { value: 'default', label: 'Default merge' },
  { value: 'no-ff', label: 'Merge commit' },
];

export function PullsSection() {
  const { data: settings } = useSettings();
  const update = useUpdateSettings();
  const { navigate } = useNavigation();
  if (!settings) return null;

  return (
    <>
      <PageTitle title="Pull requests">
        How the list is laid out and what the Merge tab starts with.
      </PageTitle>
      <SettingGroup title="List">
        <SettingRow
          id="pull-requests-layout"
          label="Layout"
          description="Split keeps the list beside the selected pull request. Auto splits from 1100px of workspace."
        >
          <Segmented
            label="Pull requests layout"
            value={settings.pullRequestsLayout}
            options={LAYOUTS}
            onChange={(pullRequestsLayout) =>
              update.mutate({ pullRequestsLayout })
            }
          />
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="Merging">
        <SettingRow
          id="pull-merge-method"
          label="Merge method"
          description="Picked first on the Merge tab. A merge commit keeps the pull request visible in History."
        >
          <Segmented
            label="Merge method"
            value={settings.pullMergeMethod}
            options={METHODS}
            onChange={(pullMergeMethod) => update.mutate({ pullMergeMethod })}
          />
        </SettingRow>
        <SettingRow
          id="pull-push-after-merge"
          label="Push after merging"
          description="Pushes the target branch to its remote once the merge is done. Off keeps the merge on this computer."
        >
          <Switch
            aria-label="Push after merging"
            checked={settings.pullPushAfterMerge}
            onCheckedChange={(pullPushAfterMerge) =>
              update.mutate({ pullPushAfterMerge })
            }
          />
        </SettingRow>
        <SettingRow
          id="pull-offer-delete-branch"
          label="Offer to delete the merged branch"
          description="Shows a Delete branch button after a merge. Nothing is deleted without that click, and Git keeps a branch with unmerged commits."
        >
          <Switch
            aria-label="Offer to delete the merged branch"
            checked={settings.pullOfferDeleteBranch}
            onCheckedChange={(pullOfferDeleteBranch) =>
              update.mutate({ pullOfferDeleteBranch })
            }
          />
        </SettingRow>
        <SettingRow
          id="pull-warn-before-merge"
          label="Warn before merging"
          description="Lists a stale approval, requested changes and unresolved threads above the Merge button. They never block a merge."
        >
          <Switch
            aria-label="Warn before merging"
            checked={settings.pullWarnBeforeMerge}
            onCheckedChange={(pullWarnBeforeMerge) =>
              update.mutate({ pullWarnBeforeMerge })
            }
          />
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="Reviewing">
        <SettingRow
          id="pull-diff-settings"
          label="Diff layout, wrapping and whitespace"
          description="Reviews use the same diff settings as Changes."
        >
          <Button
            size="sm"
            onClick={() => navigate({ name: 'settings', section: 'code' })}
          >
            Open Code settings
          </Button>
        </SettingRow>
      </SettingGroup>
    </>
  );
}
