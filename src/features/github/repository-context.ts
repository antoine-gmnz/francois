import { createContext, useContext } from 'react';
import type { RepositoryProvider } from '../../../contract/gitlab-integration';
import { repositoryLabels } from '../../lib/repository-provider';

export const RepositoryContext = createContext<RepositoryProvider>('github');
export function useRepositoryLabels() {
  const provider = useContext(RepositoryContext);
  return { provider, ...repositoryLabels(provider) };
}
