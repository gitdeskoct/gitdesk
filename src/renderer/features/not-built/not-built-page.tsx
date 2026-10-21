import type { ReactNode } from 'react';
import {
  IssuesArt,
  PullRequestsArt,
  RepositoriesArt,
} from '../../components/illustrations';
import { Button } from '../../components/ui/button';
import { EmptyState } from '../../components/ui/empty-state';
import { useNavigation } from '../../app/navigation';
import { Page } from '../shell/page';

type Unbuilt = 'repositories' | 'pulls' | 'issues';

const pages: Record<
  Unbuilt,
  { label: string; art: ReactNode; title: string; body: string }
> = {
  repositories: {
    label: 'Repositories',
    art: <RepositoriesArt />,
    title: 'Repositories are not built yet',
    body: 'Opening, cloning and creating repositories arrive in the next feature. Local Git already works from your terminal.',
  },
  pulls: {
    label: 'Pull requests',
    art: <PullRequestsArt />,
    title: 'Pull requests are not built yet',
    body: 'Reviewing and merging branches arrives after repositories.',
  },
  issues: {
    label: 'Issues',
    art: <IssuesArt />,
    title: 'Issues are not built yet',
    body: 'Tracking work against your repositories arrives after repositories and pull requests.',
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
          name === 'repositories' ? (
            <Button
              onClick={() =>
                navigate({
                  name: 'settings',
                  section: 'git',
                  row: 'git-identity',
                })
              }
            >
              Set up Git identity
            </Button>
          ) : (
            <Button onClick={() => navigate({ name: 'home' })}>
              Go to Home
            </Button>
          )
        }
      >
        {page.body}
      </EmptyState>
    </Page>
  );
}
