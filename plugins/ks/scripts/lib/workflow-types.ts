export interface SlackThread {
  channel_id: string;
  channel_name: string;
  ts: string;
  url: string | null;
}

/** @deprecated Legacy `slack.pr_review_threads[]` entries — new writes go to `PrEntry.review_thread` in the top-level `prs[]` array. */
export interface PrReviewThread {
  channel_id: string;
  channel_name: string;
  ts: string;
  url: string | null;
  pr_url: string | null;
}

/** A PR raised for this workflow. Written at PR-creation time; `review_thread` filled in when sent for review in Slack. */
export interface PrEntry {
  url: string;
  title: string | null;
  branch: string | null;
  target: string | null;
  created_at: string | null;
  review_thread: SlackThread | null;
}

export type PhaseStatus = 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED' | 'SKIPPED';

export interface Phase {
  number: number;
  name: string;
  status: PhaseStatus;
  started_at: string | null;
  ended_at: string | null;
}

export interface SlackState {
  project_thread: SlackThread | null;
  pr_review_threads: PrReviewThread[];
  release_thread: SlackThread | null;
}
