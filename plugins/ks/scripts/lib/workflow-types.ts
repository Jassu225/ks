export interface SlackThread {
  channel_id: string;
  channel_name: string;
  ts: string;
  url: string | null;
}

export interface PrReviewThread {
  channel_id: string;
  channel_name: string;
  ts: string;
  url: string | null;
  pr_url: string | null;
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
