import type { ReactNode } from 'react';
import { IssuesArt, PullRequestsArt } from '../../components/illustrations';
import { Button } from '../../components/ui/button';
import { EmptyState } from '../../components/ui/empty-state';
import { useNavigation } from '../../app/navigation';
import { Page } from '../shell/page';

type Unbuilt = 'pulls' | 'issues';

const pages: Record<
  Unbuilt,
  { label: string; art: ReactNode; title: string; body: string }
> = {
  pulls: {
    label: 'Pull requests',
    art: <PullRequestsArt />,
    title: 'Pull requests are not built yet',
    body: 'Reviewing and merging branches arrives in a later feature.',
  },
  issues: {
    label: 'Issues',
    art: <IssuesArt />,
    title: 'Issues are not built yet',
    body: 'Tracking work against your repositories arrives after pull requests.',
  },
};

export function NotBuiltPage({ name }: { name: Unbuilt }) {
  const { navigate } = useNavigation();
  const page = pages[name];
  return (
    <Page crumbs={[{ label: 'Code' }, { label: page.label }]}>
      <EmptyState
        art={page.art}
        title={page.title}
        action={
          <Button onClick={() => navigate({ name: 'repositories' })}>
            Go to Repositories
          </Button>
        }
      >
        {page.body}
      </EmptyState>
    </Page>
  );
}
