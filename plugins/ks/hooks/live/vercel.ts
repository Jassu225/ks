import type { PreviewDeploy } from '../../types'

// Vercel builds a preview of every pushed branch (its GitHub integration), so
// each PR's preview is the newest deployment of the PR's branch.

/** States in which a deployment is still on its way. */
export const ACTIVE_STATES: ReadonlySet<string> = new Set(['QUEUED', 'INITIALIZING', 'BUILDING'])

/** `{ org, repo }` from a GitHub remote URL (ssh or https). */
export function githubRepo(remote: string | null): { org: string; repo: string } | null {
  const m = /github\.com[:/]([^/]+)\/([^/]+?)(\.git)?\/?$/.exec(remote?.trim() ?? '')
  return m?.[1] && m[2] ? { org: m[1], repo: m[2] } : null
}

type Deployment = {
  id?: unknown
  url?: unknown
  state?: unknown
  created?: unknown
  inspectorUrl?: unknown
  meta?: { githubCommitRef?: unknown; githubCommitSha?: unknown; githubRepo?: unknown }
}

/**
 * The newest deployment of `branch` in `repo`, from the text `list_deployments`
 * answers with (`{ result: { deployments: { deployments: [...] } } }`); null
 * when it holds none.
 */
export function latestPreview(text: string, branch: string, repo: string, checkedMinute: number): PreviewDeploy | null {
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    return null
  }
  const root = doc as { result?: { deployments?: { deployments?: unknown } }; deployments?: unknown } | null
  const listed = root?.result?.deployments?.deployments ?? root?.deployments
  if (!Array.isArray(listed)) return null

  const newest = (listed as Deployment[])
    .filter(d => d.meta?.githubCommitRef === branch && (d.meta?.githubRepo === undefined || d.meta.githubRepo === repo))
    .sort((a, b) => Number(b.created ?? 0) - Number(a.created ?? 0))[0]
  if (!newest || typeof newest.state !== 'string' || typeof newest.id !== 'string') return null

  return {
    id: newest.id,
    branch,
    state: newest.state,
    url: typeof newest.url === 'string' ? `https://${newest.url}` : null,
    // Filled in by the caller: it takes a second call (branchAlias).
    branchUrl: null,
    inspectorUrl: typeof newest.inspectorUrl === 'string' ? newest.inspectorUrl : null,
    sha: typeof newest.meta?.githubCommitSha === 'string' ? newest.meta.githubCommitSha : null,
    createdAt: Number(newest.created ?? 0),
    checkedMinute,
  }
}

/**
 * The branch's stable alias, from what `list_deployment_aliases` answers
 * (`{ result: { aliases: [{ alias }] } }`): the `-git-<branch>` one, which
 * Vercel moves to each new build of the branch. Null when there is none yet (a
 * branch's first build, still building).
 */
export function branchAlias(text: string): string | null {
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    return null
  }
  const root = doc as { result?: { aliases?: unknown }; aliases?: unknown } | null
  const listed = root?.result?.aliases ?? root?.aliases
  if (!Array.isArray(listed)) return null
  const names = listed.flatMap(a => {
    const alias = (a as { alias?: unknown } | null)?.alias
    return typeof alias === 'string' ? [alias] : []
  })
  const alias = names.find(n => n.includes('-git-')) ?? names[0]
  return alias ? `https://${alias}` : null
}

/** A PR's deploy pill: where its preview stands, and where it links. */
export function deployPill(d: PreviewDeploy): { text: string; bg: string; fg: string; href: string | null } {
  if (ACTIVE_STATES.has(d.state)) return { text: '▲ DEPLOYING', bg: '#2563eb', fg: '#ffffff', href: d.inspectorUrl }
  if (d.state === 'READY') return { text: '▲ PREVIEW', bg: '#16a34a', fg: '#ffffff', href: d.branchUrl ?? d.url }
  if (d.state === 'ERROR') return { text: '▲ PREVIEW FAILED', bg: '#dc2626', fg: '#ffffff', href: d.inspectorUrl }
  return { text: `▲ ${d.state}`, bg: '#475569', fg: '#e2e8f0', href: d.inspectorUrl }
}
