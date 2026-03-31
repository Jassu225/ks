import { WebClient } from '@slack/web-api';
import type { SlackThread } from './workflow-types.js';

/**
 * Parse a Slack message URL into channel/timestamp components.
 * Optionally resolves channel name via Slack API if SLACK_TOKEN is set.
 */
export async function parseSlackMessageUrl(url: string): Promise<SlackThread> {
  const match = url.match(/slack\.com\/archives\/([A-Z0-9]+)\/p(\d+)/i);
  if (!match) {
    throw new Error('Invalid Slack message URL. Expected format: https://{workspace}.slack.com/archives/{channel}/p{timestamp}');
  }
  const channel_id = match[1];
  const rawTs = match[2];
  // Insert dot before last 6 digits: 1234567890123456 -> 1234567890.123456
  const ts = rawTs.slice(0, -6) + '.' + rawTs.slice(-6);

  let channel_name = '';
  const slackToken = process.env.SLACK_TOKEN;
  if (slackToken) {
    try {
      const slack = new WebClient(slackToken);
      const result = await slack.conversations.info({ channel: channel_id });
      channel_name = result.channel?.name ? `#${result.channel.name}` : '';
    } catch {
      // Non-fatal -- channel name is best-effort
    }
  }

  return { channel_id, channel_name, ts, url };
}
