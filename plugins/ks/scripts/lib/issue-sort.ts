import { LinearDocument } from '@linear/sdk';

/** The orders `linear issue list --sort` takes. */
export const ISSUE_SORTS = ['manual', 'created', 'updated'] as const;
export type IssueSort = (typeof ISSUE_SORTS)[number];

/**
 * The `sort` argument of the `issues` query for `--sort`. Linear sorts before
 * it applies `first`, so the first N are the true first N; a sort applied to
 * the fetched page instead would drop the issues ranked above it that the page
 * left out (a cycle larger than --limit). "manual" is Linear's drag-and-drop
 * order (Issue.sortOrder, ascending = top of the list).
 */
export function issueSort(order: IssueSort | undefined): LinearDocument.IssueSortInput[] | undefined {
  const { Ascending, Descending } = LinearDocument.PaginationSortOrder;
  switch (order) {
    case 'manual':
      return [{ manual: { order: Ascending } }];
    case 'created':
      return [{ createdAt: { order: Descending } }];
    case 'updated':
      return [{ updatedAt: { order: Descending } }];
    default:
      return undefined;
  }
}
