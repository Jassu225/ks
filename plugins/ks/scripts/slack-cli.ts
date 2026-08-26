#!/usr/bin/env npx tsx
/**
 * Slack CLI - A comprehensive command-line interface for the Slack API
 * Uses the official @slack/web-api for all operations
 *
 * Usage: npx tsx slack-cli.ts <command> [options]
 *
 * Environment: SLACK_TOKEN must be set (loaded from .env file)
 */

import { WebClient } from '@slack/web-api';
import { Command, Option } from 'commander';
import chalk from 'chalk';
import { createReadStream, readFileSync, readdirSync } from 'fs';
import { basename, join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import { loadEnv } from './lib/env.js';

loadEnv();

// ============================================================================
// Client Initialization
// ============================================================================

function getClient(): WebClient {
  const token = process.env.SLACK_TOKEN;
  if (!token) {
    console.error(chalk.red('Error: SLACK_TOKEN environment variable is not set'));
    console.error(chalk.yellow('Set a bot token (xoxb-) or user token (xoxp-) from: https://api.slack.com/apps'));
    process.exit(1);
  }
  return new WebClient(token);
}

// ============================================================================
// Output Helpers
// ============================================================================

function output(data: unknown, json: boolean = false): void {
  if (json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(data);
  }
}

function formatDate(date: Date | string | undefined): string {
  if (!date) return 'N/A';
  const d = new Date(date);
  return d.toISOString().split('T')[0];
}

function formatTimestamp(ts: string | undefined): string {
  if (!ts) return 'N/A';
  const seconds = parseFloat(ts);
  const d = new Date(seconds * 1000);
  return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

// ============================================================================
// Resolution Helpers
// ============================================================================

async function resolveChannel(client: WebClient, nameOrId: string): Promise<string> {
  // If it looks like a Slack channel ID (C, D, or G followed by uppercase alphanumeric)
  if (/^[CDG][A-Z0-9]+$/.test(nameOrId)) {
    return nameOrId;
  }

  // Strip leading # if present
  const name = nameOrId.replace(/^#/, '');

  let cursor: string | undefined;
  do {
    const result = await client.conversations.list({
      types: 'public_channel,private_channel',
      limit: 200,
      cursor,
    });

    const channel = result.channels?.find(c => c.name === name);
    if (channel?.id) {
      return channel.id;
    }

    cursor = result.response_metadata?.next_cursor;
  } while (cursor);

  console.error(chalk.red(`Channel not found: ${nameOrId}`));
  process.exit(1);
}

/** The subset of `users.list` / `users.info` member fields this CLI reads. */
type SlackMember = {
  id?: string;
  name?: string;
  real_name?: string;
  is_admin?: boolean;
  is_bot?: boolean;
  is_app_user?: boolean;
  deleted?: boolean;
  profile?: { display_name?: string; status_text?: string; status_emoji?: string };
};

/** The subset of `usergroups.list` fields this CLI reads. */
type SlackUserGroup = {
  id?: string;
  name?: string;
  handle?: string;
  description?: string;
  is_external?: boolean;
  date_create?: number;
  date_update?: number;
  date_delete?: number;
  created_by?: string;
  user_count?: number;
  auto_type?: string | null;
  prefs?: { channels?: string[]; groups?: string[] };
};

/**
 * Fetch workspace members, following the `users.list` cursor.
 *
 * `max` caps the number returned; page size is capped at Slack's recommended
 * 200. Returns the members plus whether Slack had more to give, so callers can
 * tell "that's everyone" from "that's the first N".
 */
async function fetchUsers(
  client: WebClient,
  max: number = Infinity
): Promise<{ members: SlackMember[]; truncated: boolean }> {
  const members: SlackMember[] = [];
  let cursor: string | undefined;

  do {
    const remaining = max === Infinity ? 200 : max - members.length;
    if (remaining <= 0) {
      return { members, truncated: true };
    }
    const result = await client.users.list({ limit: Math.min(200, remaining), cursor });
    members.push(...(result.members ?? []));
    cursor = result.response_metadata?.next_cursor || undefined;
  } while (cursor);

  return { members, truncated: false };
}

/** Every workspace member, fetched at most once per invocation. */
let cachedUsers: SlackMember[] | undefined;

async function allUsers(client: WebClient): Promise<SlackMember[]> {
  if (!cachedUsers) {
    cachedUsers = (await fetchUsers(client)).members;
  }
  return cachedUsers;
}

function matchUser(members: SlackMember[], handle: string): SlackMember | undefined {
  const wanted = handle.toLowerCase();
  return members.find(
    m =>
      m.name?.toLowerCase() === wanted ||
      m.real_name?.toLowerCase() === wanted ||
      m.profile?.display_name?.toLowerCase() === wanted
  );
}

/** Every user group (disabled ones included), fetched at most once per invocation. */
let cachedUserGroups: SlackUserGroup[] | undefined;

async function allUserGroups(client: WebClient): Promise<SlackUserGroup[]> {
  if (!cachedUserGroups) {
    const result = await client.usergroups.list({ include_disabled: true, include_count: true });
    cachedUserGroups = (result.usergroups ?? []) as SlackUserGroup[];
  }
  return cachedUserGroups;
}

async function resolveUser(client: WebClient, nameOrId: string): Promise<string> {
  // Slack user IDs start with U, or W on Enterprise Grid.
  if (/^[UW][A-Z0-9]+$/.test(nameOrId)) {
    return nameOrId;
  }

  // If it contains @ anywhere but the front, treat it as an email
  // ('@handle' is a handle, not an address).
  if (nameOrId.includes('@') && !nameOrId.startsWith('@')) {
    try {
      const result = await client.users.lookupByEmail({ email: nameOrId });
      if (result.user?.id) {
        return result.user.id;
      }
    } catch {
      // Fall through to name search
    }
  }

  // Search by name/real_name/display_name
  const user = matchUser(await allUsers(client), nameOrId.replace(/^@/, ''));
  if (user?.id) {
    return user.id;
  }

  console.error(chalk.red(`User not found: ${nameOrId}`));
  process.exit(1);
}

async function resolveUserGroup(client: WebClient, nameOrId: string): Promise<SlackUserGroup> {
  const groups = await allUserGroups(client);
  const wanted = nameOrId.replace(/^@/, '').toLowerCase();

  const group = /^S[A-Z0-9]+$/.test(nameOrId)
    ? groups.find(g => g.id === nameOrId)
    : groups.find(g => g.handle?.toLowerCase() === wanted || g.name?.toLowerCase() === wanted);

  if (!group) {
    console.error(chalk.red(`User group not found: ${nameOrId}`));
    process.exit(1);
  }
  return group;
}

/** @here, @channel, @everyone — encoded as bang-mentions rather than user IDs. */
const SPECIAL_MENTIONS = new Set(['here', 'channel', 'everyone']);

/**
 * Plain `@handle` text does not notify anyone — Slack only pings on encoded
 * mentions. Rewrite handles into that syntax: users become `<@U123>`, user
 * groups become `<!subteam^S123|@handle>`, and @here/@channel/@everyone become
 * `<!here>` and friends.
 *
 * The lookbehind keeps email addresses (`a@b.com`) and already-encoded mentions
 * (`<@U123>`, `<!subteam^S1|@eng>`) out of the match. Handles that resolve to
 * nothing are left exactly as typed.
 */
async function resolveMentions(client: WebClient, text: string): Promise<string> {
  const MENTION = /(?<![A-Za-z0-9._%+\-<|^])@([A-Za-z0-9][A-Za-z0-9._-]*)/g;

  const handles = [...text.matchAll(MENTION)].map(m => m[1].replace(/[._-]+$/, ''));
  if (handles.length === 0) {
    return text;
  }

  const encoded = new Map<string, string>();
  // A token without users:read / usergroups:read must still be able to post —
  // failed lookups downgrade to literal text instead of aborting the message.
  let usersUnavailable = false;
  let groupsUnavailable = false;

  for (const handle of new Set(handles)) {
    const key = handle.toLowerCase();
    if (encoded.has(key)) continue;

    if (SPECIAL_MENTIONS.has(key)) {
      encoded.set(key, `<!${key}>`);
      continue;
    }

    if (!usersUnavailable) {
      try {
        const user = matchUser(await allUsers(client), handle);
        if (user?.id) {
          encoded.set(key, `<@${user.id}>`);
          continue;
        }
      } catch {
        usersUnavailable = true;
      }
    }

    if (groupsUnavailable) continue;
    try {
      const group = (await allUserGroups(client)).find(
        g => g.handle?.toLowerCase() === key || g.name?.toLowerCase() === key
      );
      if (group?.id) {
        encoded.set(key, `<!subteam^${group.id}|@${group.handle ?? handle}>`);
      }
    } catch {
      groupsUnavailable = true;
    }
  }

  return text.replace(MENTION, (full, raw: string) => {
    const handle = raw.replace(/[._-]+$/, '');
    const replacement = encoded.get(handle.toLowerCase());
    // Re-attach trailing punctuation that was trimmed off the handle.
    return replacement ? replacement + raw.slice(handle.length) : full;
  });
}

// ============================================================================
// Channel Commands
// ============================================================================

async function listChannels(options: { type?: string; limit?: number; excludeArchived?: boolean; json?: boolean }): Promise<void> {
  const client = getClient();

  try {
    const result = await client.conversations.list({
      types: options.type || 'public_channel',
      limit: options.limit || 100,
      exclude_archived: options.excludeArchived ?? true,
    });

    const channels = result.channels || [];

    const data = channels.map(c => ({
      id: c.id,
      name: c.name,
      topic: c.topic?.value || '',
      purpose: c.purpose?.value || '',
      numMembers: c.num_members,
      isPrivate: c.is_private,
      isArchived: c.is_archived,
      created: c.created,
    }));

    if (options.json) {
      output(data, true);
    } else {
      console.log(chalk.bold('\nChannels:\n'));
      data.forEach(c => {
        const icon = c.isPrivate ? '🔒' : '#';
        const archived = c.isArchived ? chalk.gray(' (archived)') : '';
        console.log(`${chalk.cyan(`${icon} ${c.name}`)}${archived}`);
        console.log(`  ID: ${c.id} | Members: ${c.numMembers || 'N/A'}`);
        if (c.topic) {
          console.log(`  Topic: ${c.topic}`);
        }
        if (c.purpose) {
          console.log(`  Purpose: ${c.purpose}`);
        }
        console.log();
      });
    }
  } catch (error) {
    const err = error as Error & { data?: { error?: string; response_metadata?: { messages?: string[] } } };
    console.error(chalk.red(`Failed to list channels: ${err.data?.error || err.message}`));
    if (err.data?.response_metadata?.messages) {
      err.data.response_metadata.messages.forEach((msg: string) => {
        console.error(chalk.red(`  ${msg}`));
      });
    }
    process.exit(1);
  }
}

async function getChannelInfo(channel: string, options: { json?: boolean }): Promise<void> {
  const client = getClient();

  try {
    const channelId = await resolveChannel(client, channel);
    const result = await client.conversations.info({ channel: channelId });
    const c = result.channel;

    if (!c) {
      console.error(chalk.red(`Channel not found: ${channel}`));
      process.exit(1);
    }

    const data = {
      id: c.id,
      name: c.name,
      topic: c.topic?.value || '',
      purpose: c.purpose?.value || '',
      numMembers: c.num_members,
      isPrivate: c.is_private,
      isArchived: c.is_archived,
      created: c.created,
      creator: c.creator,
    };

    if (options.json) {
      output(data, true);
    } else {
      const icon = data.isPrivate ? '🔒' : '#';
      console.log(chalk.bold(`\n${icon} ${data.name}\n`));
      console.log(`ID: ${data.id}`);
      console.log(`Members: ${data.numMembers || 'N/A'}`);
      console.log(`Private: ${data.isPrivate ? 'Yes' : 'No'}`);
      console.log(`Archived: ${data.isArchived ? 'Yes' : 'No'}`);
      console.log(`Creator: ${data.creator || 'N/A'}`);
      console.log(`Created: ${data.created ? formatTimestamp(String(data.created)) : 'N/A'}`);
      if (data.topic) {
        console.log(`Topic: ${data.topic}`);
      }
      if (data.purpose) {
        console.log(`Purpose: ${data.purpose}`);
      }
    }
  } catch (error) {
    const err = error as Error & { data?: { error?: string; response_metadata?: { messages?: string[] } } };
    console.error(chalk.red(`Failed to get channel info: ${err.data?.error || err.message}`));
    if (err.data?.response_metadata?.messages) {
      err.data.response_metadata.messages.forEach((msg: string) => {
        console.error(chalk.red(`  ${msg}`));
      });
    }
    process.exit(1);
  }
}

async function createChannel(name: string, options: { private?: boolean; json?: boolean }): Promise<void> {
  const client = getClient();

  try {
    const result = await client.conversations.create({
      name,
      is_private: options.private || false,
    });

    const c = result.channel;

    if (!c) {
      console.error(chalk.red('Failed to create channel'));
      process.exit(1);
    }

    const data = {
      id: c.id,
      name: c.name,
      isPrivate: c.is_private,
    };

    if (options.json) {
      output(data, true);
    } else {
      console.log(chalk.green(`\n✓ Created channel: #${data.name}`));
      console.log(`  ID: ${data.id}`);
    }
  } catch (error) {
    const err = error as Error & { data?: { error?: string; response_metadata?: { messages?: string[] } } };
    console.error(chalk.red(`Failed to create channel: ${err.data?.error || err.message}`));
    if (err.data?.response_metadata?.messages) {
      err.data.response_metadata.messages.forEach((msg: string) => {
        console.error(chalk.red(`  ${msg}`));
      });
    }
    process.exit(1);
  }
}

async function archiveChannel(channel: string, options: { json?: boolean }): Promise<void> {
  const client = getClient();

  try {
    const channelId = await resolveChannel(client, channel);
    await client.conversations.archive({ channel: channelId });

    if (options.json) {
      output({ success: true, channel: channelId }, true);
    } else {
      console.log(chalk.green(`✓ Archived channel: ${channel}`));
    }
  } catch (error) {
    const err = error as Error & { data?: { error?: string; response_metadata?: { messages?: string[] } } };
    console.error(chalk.red(`Failed to archive channel: ${err.data?.error || err.message}`));
    if (err.data?.response_metadata?.messages) {
      err.data.response_metadata.messages.forEach((msg: string) => {
        console.error(chalk.red(`  ${msg}`));
      });
    }
    process.exit(1);
  }
}

async function getChannelHistory(channel: string, options: { limit?: number; oldest?: string; latest?: string; json?: boolean }): Promise<void> {
  const client = getClient();

  try {
    const channelId = await resolveChannel(client, channel);

    const params: Record<string, unknown> = {
      channel: channelId,
      limit: options.limit || 20,
    };

    // Convert ISO date strings to Unix timestamps
    if (options.oldest) {
      params.oldest = String(new Date(options.oldest).getTime() / 1000);
    }
    if (options.latest) {
      params.latest = String(new Date(options.latest).getTime() / 1000);
    }

    const result = await client.conversations.history(params as unknown as Parameters<typeof client.conversations.history>[0]);
    const messages = result.messages || [];

    const data = messages.map(m => ({
      ts: m.ts,
      user: m.user,
      text: m.text,
      type: m.type,
      subtype: m.subtype,
      threadTs: m.thread_ts,
      replyCount: m.reply_count,
      datetime: formatTimestamp(m.ts),
    }));

    if (options.json) {
      output(data, true);
    } else {
      console.log(chalk.bold(`\nHistory for ${channel}:\n`));
      if (data.length === 0) {
        console.log(chalk.gray('No messages found.'));
      } else {
        data.forEach(m => {
          const thread = m.replyCount ? chalk.gray(` [${m.replyCount} replies]`) : '';
          console.log(`${chalk.gray(m.datetime)} ${chalk.cyan(m.user || 'system')}${thread}`);
          console.log(`  ${m.text}`);
          console.log();
        });
      }
    }
  } catch (error) {
    const err = error as Error & { data?: { error?: string; response_metadata?: { messages?: string[] } } };
    console.error(chalk.red(`Failed to get channel history: ${err.data?.error || err.message}`));
    if (err.data?.response_metadata?.messages) {
      err.data.response_metadata.messages.forEach((msg: string) => {
        console.error(chalk.red(`  ${msg}`));
      });
    }
    process.exit(1);
  }
}

async function inviteToChannel(channel: string, user: string, options: { json?: boolean }): Promise<void> {
  const client = getClient();

  try {
    const channelId = await resolveChannel(client, channel);
    const userId = await resolveUser(client, user);

    await client.conversations.invite({ channel: channelId, users: userId });

    if (options.json) {
      output({ success: true, channel: channelId, user: userId }, true);
    } else {
      console.log(chalk.green(`✓ Invited ${user} to ${channel}`));
    }
  } catch (error) {
    const err = error as Error & { data?: { error?: string; response_metadata?: { messages?: string[] } } };
    console.error(chalk.red(`Failed to invite user: ${err.data?.error || err.message}`));
    if (err.data?.response_metadata?.messages) {
      err.data.response_metadata.messages.forEach((msg: string) => {
        console.error(chalk.red(`  ${msg}`));
      });
    }
    process.exit(1);
  }
}

async function kickFromChannel(channel: string, user: string, options: { json?: boolean }): Promise<void> {
  const client = getClient();

  try {
    const channelId = await resolveChannel(client, channel);
    const userId = await resolveUser(client, user);

    await client.conversations.kick({ channel: channelId, user: userId });

    if (options.json) {
      output({ success: true, channel: channelId, user: userId }, true);
    } else {
      console.log(chalk.green(`✓ Removed ${user} from ${channel}`));
    }
  } catch (error) {
    const err = error as Error & { data?: { error?: string; response_metadata?: { messages?: string[] } } };
    console.error(chalk.red(`Failed to remove user: ${err.data?.error || err.message}`));
    if (err.data?.response_metadata?.messages) {
      err.data.response_metadata.messages.forEach((msg: string) => {
        console.error(chalk.red(`  ${msg}`));
      });
    }
    process.exit(1);
  }
}

async function setChannelTopic(channel: string, topic: string, options: { json?: boolean }): Promise<void> {
  const client = getClient();

  try {
    const channelId = await resolveChannel(client, channel);
    const result = await client.conversations.setTopic({ channel: channelId, topic });

    if (options.json) {
      output({ success: true, channel: channelId, topic: result.channel?.topic?.value }, true);
    } else {
      console.log(chalk.green(`✓ Set topic for ${channel}`));
    }
  } catch (error) {
    const err = error as Error & { data?: { error?: string; response_metadata?: { messages?: string[] } } };
    console.error(chalk.red(`Failed to set topic: ${err.data?.error || err.message}`));
    if (err.data?.response_metadata?.messages) {
      err.data.response_metadata.messages.forEach((msg: string) => {
        console.error(chalk.red(`  ${msg}`));
      });
    }
    process.exit(1);
  }
}

async function setChannelPurpose(channel: string, purpose: string, options: { json?: boolean }): Promise<void> {
  const client = getClient();

  try {
    const channelId = await resolveChannel(client, channel);
    const result = await client.conversations.setPurpose({ channel: channelId, purpose });

    if (options.json) {
      output({ success: true, channel: channelId, purpose: result.channel?.purpose?.value }, true);
    } else {
      console.log(chalk.green(`✓ Set purpose for ${channel}`));
    }
  } catch (error) {
    const err = error as Error & { data?: { error?: string; response_metadata?: { messages?: string[] } } };
    console.error(chalk.red(`Failed to set purpose: ${err.data?.error || err.message}`));
    if (err.data?.response_metadata?.messages) {
      err.data.response_metadata.messages.forEach((msg: string) => {
        console.error(chalk.red(`  ${msg}`));
      });
    }
    process.exit(1);
  }
}

// ============================================================================
// Message Commands
// ============================================================================

async function sendMessage(channel: string, text: string, options: { threadTs?: string; blocks?: string; file?: string[]; resolveMentions?: boolean; json?: boolean }): Promise<void> {
  const client = getClient();

  try {
    const channelId = await resolveChannel(client, channel);
    const files = options.file ?? [];
    // --no-resolve-mentions sets this false; --blocks content is never rewritten.
    const body = options.resolveMentions === false ? text : await resolveMentions(client, text);

    if (files.length > 0) {
      const result = await client.filesUploadV2({
        channel_id: channelId,
        initial_comment: body,
        thread_ts: options.threadTs,
        file_uploads: files.map((p) => ({
          file: createReadStream(p),
          filename: basename(p),
        })),
      });

      type ShareEntry = { ts?: string };
      type Shares = { public?: Record<string, ShareEntry[]>; private?: Record<string, ShareEntry[]> };
      const uploaded = result.files?.[0] as { files?: Array<{ shares?: Shares }>; shares?: Shares } | undefined;
      const shares = uploaded?.shares ?? uploaded?.files?.[0]?.shares;
      const shareEntry = shares?.public?.[channelId]?.[0] ?? shares?.private?.[channelId]?.[0];
      const ts = shareEntry?.ts;

      if (options.json) {
        output({ ok: result.ok, channel: channelId, ts, files: result.files }, true);
      } else {
        console.log(chalk.green(`✓ Message sent with ${files.length} attachment${files.length === 1 ? '' : 's'} to ${channel}`));
        if (ts) {
          console.log(`  Timestamp: ${ts}`);
        }
      }
      return;
    }

    const params: Record<string, unknown> = {
      channel: channelId,
      text: body,
    };

    if (options.threadTs) {
      params.thread_ts = options.threadTs;
    }

    if (options.blocks) {
      try {
        params.blocks = JSON.parse(options.blocks);
      } catch {
        console.error(chalk.red('Failed to parse --blocks JSON'));
        process.exit(1);
      }
    }

    const result = await client.chat.postMessage(params as unknown as Parameters<typeof client.chat.postMessage>[0]);

    const data = {
      ok: result.ok,
      channel: result.channel,
      ts: result.ts,
      message: result.message,
    };

    if (options.json) {
      output(data, true);
    } else {
      console.log(chalk.green(`✓ Message sent to ${channel}`));
      console.log(`  Timestamp: ${data.ts}`);
    }
  } catch (error) {
    const err = error as Error & { data?: { error?: string; response_metadata?: { messages?: string[] } } };
    console.error(chalk.red(`Failed to send message: ${err.data?.error || err.message}`));
    if (err.data?.response_metadata?.messages) {
      err.data.response_metadata.messages.forEach((msg: string) => {
        console.error(chalk.red(`  ${msg}`));
      });
    }
    process.exit(1);
  }
}

async function updateMessage(channel: string, ts: string, text: string, options: { resolveMentions?: boolean; json?: boolean }): Promise<void> {
  const client = getClient();

  try {
    const channelId = await resolveChannel(client, channel);
    const body = options.resolveMentions === false ? text : await resolveMentions(client, text);
    const result = await client.chat.update({ channel: channelId, ts, text: body });

    const data = {
      ok: result.ok,
      channel: result.channel,
      ts: result.ts,
    };

    if (options.json) {
      output(data, true);
    } else {
      console.log(chalk.green(`✓ Message updated in ${channel}`));
      console.log(`  Timestamp: ${data.ts}`);
    }
  } catch (error) {
    const err = error as Error & { data?: { error?: string; response_metadata?: { messages?: string[] } } };
    console.error(chalk.red(`Failed to update message: ${err.data?.error || err.message}`));
    if (err.data?.response_metadata?.messages) {
      err.data.response_metadata.messages.forEach((msg: string) => {
        console.error(chalk.red(`  ${msg}`));
      });
    }
    process.exit(1);
  }
}

async function deleteMessage(channel: string, ts: string, options: { json?: boolean }): Promise<void> {
  const client = getClient();

  try {
    const channelId = await resolveChannel(client, channel);
    await client.chat.delete({ channel: channelId, ts });

    if (options.json) {
      output({ success: true, channel: channelId, ts }, true);
    } else {
      console.log(chalk.green(`✓ Message deleted from ${channel}`));
    }
  } catch (error) {
    const err = error as Error & { data?: { error?: string; response_metadata?: { messages?: string[] } } };
    console.error(chalk.red(`Failed to delete message: ${err.data?.error || err.message}`));
    if (err.data?.response_metadata?.messages) {
      err.data.response_metadata.messages.forEach((msg: string) => {
        console.error(chalk.red(`  ${msg}`));
      });
    }
    process.exit(1);
  }
}

async function getThread(channel: string, ts: string, options: { limit?: number; json?: boolean }): Promise<void> {
  const client = getClient();

  try {
    const channelId = await resolveChannel(client, channel);

    // conversations.replies returns the parent first, then the replies in order.
    // Paginate: a long thread exceeds one page, and a half-read thread is worse
    // than a slow one. Page size max is 1000 for this method (not 200 like
    // conversations.history) — but a commercially distributed non-Marketplace
    // app is capped at 15, so trust next_cursor rather than the count.
    const messages: NonNullable<Awaited<ReturnType<typeof client.conversations.replies>>['messages']> = [];
    let cursor: string | undefined;
    const limit = options.limit || 1000;

    do {
      const result = await client.conversations.replies({
        channel: channelId,
        ts,
        limit: Math.min(limit - messages.length, 1000),
        ...(cursor ? { cursor } : {}),
      });
      messages.push(...(result.messages || []));
      cursor = result.response_metadata?.next_cursor || undefined;
    } while (cursor && messages.length < limit);

    const data = messages.map((m, i) => ({
      ts: m.ts,
      user: m.user,
      text: m.text,
      type: m.type,
      // Present at runtime (thread_broadcast, tombstone, …) but absent from
      // this method's MessageElement type, unlike conversations.history's.
      subtype: (m as { subtype?: string }).subtype,
      threadTs: m.thread_ts,
      // Derived from thread_ts, not from position: passing a reply's ts returns
      // that reply alone, and a positional check would label it the parent.
      isParent: !m.thread_ts || m.thread_ts === m.ts,
      datetime: formatTimestamp(m.ts),
    }));

    if (options.json) {
      output(data, true);
    } else {
      console.log(chalk.bold(`\nThread in ${channel} (${ts}):\n`));
      if (data.length === 0) {
        console.log(chalk.gray('No messages found.'));
      } else {
        data.forEach(m => {
          const tag = m.isParent ? chalk.gray(' [parent]') : '';
          console.log(`${chalk.gray(m.datetime)} ${chalk.cyan(m.user || 'system')}${tag}`);
          console.log(`  ${m.text}`);
          console.log();
        });
        // A reply's ts returns that reply alone — say so, and name the ts that
        // would fetch the whole thread, rather than looking like an empty thread.
        const lone = data.length === 1 && data[0].threadTs && data[0].threadTs !== data[0].ts;
        if (lone) {
          console.log(chalk.yellow(`That ts is a reply, so only it was returned.`));
          console.log(chalk.yellow(`For the whole thread: slack message thread ${channel} ${data[0].threadTs}`));
        } else {
          console.log(chalk.gray(`${data.length - 1} ${data.length === 2 ? 'reply' : 'replies'}`));
        }
      }
    }
  } catch (error) {
    const err = error as Error & { data?: { error?: string; response_metadata?: { messages?: string[] } } };
    console.error(chalk.red(`Failed to get thread: ${err.data?.error || err.message}`));
    if (err.data?.error === 'thread_not_found') {
      // Per the API docs this means ts was missing or invalid — NOT that a
      // reply's ts was passed. Either the parent's or any reply's ts works, and
      // a message with no replies returns just itself.
      console.error(chalk.yellow('No message with that ts in this channel — check the ts and the channel match.'));
    }
    if (err.data?.response_metadata?.messages) {
      err.data.response_metadata.messages.forEach((msg: string) => {
        console.error(chalk.red(`  ${msg}`));
      });
    }
    process.exit(1);
  }
}

async function replyToMessage(channel: string, ts: string, text: string, options: { resolveMentions?: boolean; json?: boolean }): Promise<void> {
  const client = getClient();

  try {
    const channelId = await resolveChannel(client, channel);
    const body = options.resolveMentions === false ? text : await resolveMentions(client, text);
    const result = await client.chat.postMessage({
      channel: channelId,
      text: body,
      thread_ts: ts,
    });

    const data = {
      ok: result.ok,
      channel: result.channel,
      ts: result.ts,
      threadTs: ts,
    };

    if (options.json) {
      output(data, true);
    } else {
      console.log(chalk.green(`✓ Reply sent in ${channel}`));
      console.log(`  Thread: ${ts}`);
      console.log(`  Timestamp: ${data.ts}`);
    }
  } catch (error) {
    const err = error as Error & { data?: { error?: string; response_metadata?: { messages?: string[] } } };
    console.error(chalk.red(`Failed to send reply: ${err.data?.error || err.message}`));
    if (err.data?.response_metadata?.messages) {
      err.data.response_metadata.messages.forEach((msg: string) => {
        console.error(chalk.red(`  ${msg}`));
      });
    }
    process.exit(1);
  }
}

// ============================================================================
// User Commands
// ============================================================================

async function listUsers(options: { limit?: number; json?: boolean }): Promise<void> {
  const client = getClient();

  try {
    // Paginated: a single users.list page caps out well below most workspaces,
    // so an unpaginated call silently drops members and misreports the total.
    const { members, truncated } = await fetchUsers(client, options.limit || 100);

    const data = members.map(m => ({
      id: m.id,
      real_name: m.real_name || '',
      display_name: m.profile?.display_name || '',
      is_admin: m.is_admin || false,
      is_bot: m.is_bot || false,
      is_app_user: m.is_app_user || false,
      deleted: m.deleted || false,
      status_text: m.profile?.status_text || '',
      status_emoji: m.profile?.status_emoji || '',
    }));

    if (options.json) {
      output(data, true);
    } else {
      console.log(chalk.bold('\nUsers:\n'));
      data.forEach(u => {
        const activeIcon = u.deleted ? chalk.gray('○') : chalk.green('●');
        const adminBadge = u.is_admin ? chalk.yellow(' [admin]') : '';
        const botBadge = u.is_bot ? chalk.blue(' [bot]') : u.is_app_user ? chalk.blue(' [app]') : '';
        const status = u.status_text ? chalk.gray(` ${u.status_emoji} ${u.status_text}`) : '';
        const displayName = u.display_name ? chalk.gray(` (@${u.display_name})`) : '';
        console.log(`${activeIcon} ${chalk.cyan(u.real_name || u.id)}${displayName} ${chalk.gray(u.id)}${adminBadge}${botBadge}${status}`);
      });
      const total = truncated ? `First ${data.length} users` : `Total: ${data.length} users`;
      console.log(`\n${chalk.gray(total)}`);
      if (truncated) {
        console.log(chalk.gray('More available — raise --limit to see them.'));
      }
    }
  } catch (error) {
    const err = error as Error & { data?: { error?: string; response_metadata?: { messages?: string[] } } };
    console.error(chalk.red(`Failed to list users: ${err.data?.error || err.message}`));
    if (err.data?.response_metadata?.messages) {
      err.data.response_metadata.messages.forEach((msg: string) => {
        console.error(chalk.red(`  ${msg}`));
      });
    }
    process.exit(1);
  }
}

async function getUserInfo(user: string, options: { json?: boolean }): Promise<void> {
  const client = getClient();

  try {
    const userId = await resolveUser(client, user);
    const result = await client.users.info({ user: userId });
    const u = result.user;

    if (!u) {
      console.error(chalk.red(`User not found: ${user}`));
      process.exit(1);
    }

    const data = {
      id: u.id,
      name: u.name,
      real_name: u.real_name,
      display_name: u.profile?.display_name || '',
      email: u.profile?.email || '',
      title: u.profile?.title || '',
      phone: u.profile?.phone || '',
      status_text: u.profile?.status_text || '',
      status_emoji: u.profile?.status_emoji || '',
      tz: u.tz,
      tz_label: u.tz_label,
      is_admin: u.is_admin || false,
      is_bot: u.is_bot || false,
      is_app_user: u.is_app_user || false,
      deleted: u.deleted || false,
      updated: u.updated,
    };

    if (options.json) {
      output(data, true);
    } else {
      console.log(chalk.bold(`\n${data.real_name || data.name}\n`));
      console.log(`ID: ${data.id}`);
      console.log(`Username: @${data.name}`);
      if (data.display_name) console.log(`Display Name: ${data.display_name}`);
      if (data.email) console.log(`Email: ${data.email}`);
      if (data.title) console.log(`Title: ${data.title}`);
      if (data.phone) console.log(`Phone: ${data.phone}`);
      if (data.status_text) console.log(`Status: ${data.status_emoji} ${data.status_text}`);
      console.log(`Timezone: ${data.tz_label || data.tz || 'N/A'}`);
      console.log(`Admin: ${data.is_admin ? 'Yes' : 'No'}`);
      console.log(`Bot: ${data.is_bot ? 'Yes' : 'No'}`);
      console.log(`Deactivated: ${data.deleted ? 'Yes' : 'No'}`);
      if (data.updated) console.log(`Updated: ${formatTimestamp(String(data.updated))}`);
    }
  } catch (error) {
    const err = error as Error & { data?: { error?: string; response_metadata?: { messages?: string[] } } };
    console.error(chalk.red(`Failed to get user info: ${err.data?.error || err.message}`));
    if (err.data?.response_metadata?.messages) {
      err.data.response_metadata.messages.forEach((msg: string) => {
        console.error(chalk.red(`  ${msg}`));
      });
    }
    process.exit(1);
  }
}

async function getUserPresence(user: string, options: { json?: boolean }): Promise<void> {
  const client = getClient();

  try {
    const userId = await resolveUser(client, user);
    const result = await client.users.getPresence({ user: userId });

    const data = {
      user: userId,
      presence: result.presence || 'unknown',
      online: result.online ?? false,
      auto_away: result.auto_away ?? false,
      manual_away: result.manual_away ?? false,
      connection_count: result.connection_count ?? 0,
      last_activity: result.last_activity ? formatTimestamp(String(result.last_activity)) : 'N/A',
    };

    if (options.json) {
      output(data, true);
    } else {
      const statusIcon = data.presence === 'active' ? chalk.green('●') : chalk.gray('○');
      console.log(chalk.bold(`\nPresence for ${user}:\n`));
      console.log(`${statusIcon} ${data.presence}`);
      console.log(`Online: ${data.online ? 'Yes' : 'No'}`);
      console.log(`Auto Away: ${data.auto_away ? 'Yes' : 'No'}`);
      console.log(`Manual Away: ${data.manual_away ? 'Yes' : 'No'}`);
      if (data.connection_count > 0) {
        console.log(`Connections: ${data.connection_count}`);
      }
      console.log(`Last Activity: ${data.last_activity}`);
    }
  } catch (error) {
    const err = error as Error & { data?: { error?: string; response_metadata?: { messages?: string[] } } };
    console.error(chalk.red(`Failed to get user presence: ${err.data?.error || err.message}`));
    if (err.data?.response_metadata?.messages) {
      err.data.response_metadata.messages.forEach((msg: string) => {
        console.error(chalk.red(`  ${msg}`));
      });
    }
    process.exit(1);
  }
}

async function getMe(options: { json?: boolean }): Promise<void> {
  const client = getClient();

  try {
    const result = await client.auth.test();

    const data = {
      user_id: result.user_id,
      user: result.user,
      team_id: result.team_id,
      team: result.team,
      url: result.url,
      bot_id: result.bot_id,
    };

    if (options.json) {
      output(data, true);
    } else {
      console.log(chalk.bold('\nAuthenticated User:\n'));
      console.log(`User: ${data.user} (${data.user_id})`);
      console.log(`Team: ${data.team} (${data.team_id})`);
      if (data.bot_id) console.log(`Bot ID: ${data.bot_id}`);
      if (data.url) console.log(`URL: ${data.url}`);
    }
  } catch (error) {
    const err = error as Error & { data?: { error?: string; response_metadata?: { messages?: string[] } } };
    console.error(chalk.red(`Failed to get auth info: ${err.data?.error || err.message}`));
    if (err.data?.response_metadata?.messages) {
      err.data.response_metadata.messages.forEach((msg: string) => {
        console.error(chalk.red(`  ${msg}`));
      });
    }
    process.exit(1);
  }
}

// ============================================================================
// User Group Commands (read-only — requires usergroups:read)
// ============================================================================

/** Slack marks a group disabled by stamping date_delete rather than removing it. */
function isDisabledGroup(g: SlackUserGroup): boolean {
  return Boolean(g.date_delete);
}

async function listUserGroups(options: { includeDisabled?: boolean; json?: boolean }): Promise<void> {
  const client = getClient();

  try {
    const groups = (await allUserGroups(client)).filter(
      g => options.includeDisabled || !isDisabledGroup(g)
    );

    const data = groups.map(g => ({
      id: g.id,
      handle: g.handle || '',
      name: g.name || '',
      description: g.description || '',
      user_count: g.user_count ?? null,
      auto_type: g.auto_type || null,
      disabled: isDisabledGroup(g),
      default_channels: g.prefs?.channels || [],
    }));

    if (options.json) {
      output(data, true);
    } else {
      console.log(chalk.bold('\nUser groups:\n'));
      data.forEach(g => {
        const activeIcon = g.disabled ? chalk.gray('○') : chalk.green('●');
        const members = g.disabled
          ? chalk.gray(' [disabled]')
          : chalk.gray(` ${g.user_count ?? '?'} member${g.user_count === 1 ? '' : 's'}`);
        const auto = g.auto_type ? chalk.yellow(` [auto: ${g.auto_type}]`) : '';
        console.log(`${activeIcon} ${chalk.cyan(`@${g.handle}`)} ${g.name} ${chalk.gray(g.id)}${members}${auto}`);
      });
      console.log(`\n${chalk.gray(`Total: ${data.length} user groups`)}`);
    }
  } catch (error) {
    const err = error as Error & { data?: { error?: string; response_metadata?: { messages?: string[] } } };
    console.error(chalk.red(`Failed to list user groups: ${err.data?.error || err.message}`));
    if (err.data?.response_metadata?.messages) {
      err.data.response_metadata.messages.forEach((msg: string) => {
        console.error(chalk.red(`  ${msg}`));
      });
    }
    process.exit(1);
  }
}

async function getUserGroupInfo(group: string, options: { json?: boolean }): Promise<void> {
  const client = getClient();

  try {
    const g = await resolveUserGroup(client, group);
    const creator = g.created_by
      ? (await allUsers(client)).find(m => m.id === g.created_by)
      : undefined;

    const data = {
      id: g.id,
      handle: g.handle || '',
      name: g.name || '',
      description: g.description || '',
      user_count: g.user_count ?? null,
      auto_type: g.auto_type || null,
      is_external: g.is_external || false,
      disabled: isDisabledGroup(g),
      created_by: g.created_by || null,
      created_by_name: creator?.real_name || creator?.name || null,
      created_at: g.date_create || null,
      updated_at: g.date_update || null,
      default_channels: g.prefs?.channels || [],
    };

    if (options.json) {
      output(data, true);
    } else {
      console.log(chalk.bold(`\n@${data.handle} — ${data.name}\n`));
      console.log(`ID: ${data.id}`);
      if (data.description) console.log(`Description: ${data.description}`);
      console.log(`Members: ${data.user_count ?? 'N/A'}`);
      console.log(`Disabled: ${data.disabled ? 'Yes' : 'No'}`);
      if (data.auto_type) console.log(`Auto group: ${data.auto_type}`);
      if (data.is_external) console.log('Externally managed: Yes (edits happen in your IdP)');
      if (data.created_by) console.log(`Created by: ${data.created_by_name || data.created_by}`);
      if (data.created_at) console.log(`Created: ${formatTimestamp(String(data.created_at))}`);
      if (data.default_channels.length > 0) {
        console.log(`Default channels: ${data.default_channels.join(', ')}`);
      }
      console.log(chalk.gray(`\nMembers: slack usergroup users @${data.handle}`));
    }
  } catch (error) {
    const err = error as Error & { data?: { error?: string; response_metadata?: { messages?: string[] } } };
    console.error(chalk.red(`Failed to get user group info: ${err.data?.error || err.message}`));
    if (err.data?.response_metadata?.messages) {
      err.data.response_metadata.messages.forEach((msg: string) => {
        console.error(chalk.red(`  ${msg}`));
      });
    }
    process.exit(1);
  }
}

async function listUserGroupUsers(group: string, options: { json?: boolean }): Promise<void> {
  const client = getClient();

  try {
    const g = await resolveUserGroup(client, group);
    // include_disabled keeps deactivated accounts in the list, so the count
    // matches what Slack shows for the group.
    const result = await client.usergroups.users.list({
      usergroup: g.id as string,
      include_disabled: true,
    });

    const members = await allUsers(client);
    const data = (result.users || []).map(id => {
      const m = members.find(u => u.id === id);
      return {
        id,
        real_name: m?.real_name || '',
        display_name: m?.profile?.display_name || '',
        is_bot: m?.is_bot || false,
        is_app_user: m?.is_app_user || false,
        deleted: m?.deleted || false,
      };
    });

    if (options.json) {
      output({ usergroup: { id: g.id, handle: g.handle, name: g.name }, users: data }, true);
    } else {
      console.log(chalk.bold(`\n@${g.handle} — ${g.name}\n`));
      data.forEach(u => {
        const activeIcon = u.deleted ? chalk.gray('○') : chalk.green('●');
        const botBadge = u.is_bot ? chalk.blue(' [bot]') : u.is_app_user ? chalk.blue(' [app]') : '';
        const displayName = u.display_name ? chalk.gray(` (@${u.display_name})`) : '';
        console.log(`${activeIcon} ${chalk.cyan(u.real_name || u.id)}${displayName} ${chalk.gray(u.id)}${botBadge}`);
      });
      console.log(`\n${chalk.gray(`Total: ${data.length} members`)}`);
    }
  } catch (error) {
    const err = error as Error & { data?: { error?: string; response_metadata?: { messages?: string[] } } };
    console.error(chalk.red(`Failed to list user group members: ${err.data?.error || err.message}`));
    if (err.data?.response_metadata?.messages) {
      err.data.response_metadata.messages.forEach((msg: string) => {
        console.error(chalk.red(`  ${msg}`));
      });
    }
    process.exit(1);
  }
}

// ============================================================================
// File Commands
// ============================================================================

async function uploadFile(channel: string, filePaths: string[], options: { title?: string; comment?: string; threadTs?: string; json?: boolean }): Promise<void> {
  const client = getClient();

  try {
    const channelId = await resolveChannel(client, channel);

    const result = await client.filesUploadV2({
      channel_id: channelId,
      initial_comment: options.comment,
      thread_ts: options.threadTs,
      file_uploads: filePaths.map((p, idx) => ({
        file: createReadStream(p),
        filename: basename(p),
        title: filePaths.length === 1 && idx === 0 ? options.title : undefined,
      })),
    });

    if (options.json) {
      output(result, true);
    } else {
      const names = filePaths.map((p) => basename(p)).join(', ');
      console.log(chalk.green(`✓ Uploaded ${names} to ${channel}`));
    }
  } catch (error) {
    const err = error as Error & { data?: { error?: string; response_metadata?: { messages?: string[] } } };
    console.error(chalk.red(`Failed to upload file: ${err.data?.error || err.message}`));
    if (err.data?.response_metadata?.messages) {
      err.data.response_metadata.messages.forEach((msg: string) => {
        console.error(chalk.red(`  ${msg}`));
      });
    }
    process.exit(1);
  }
}

async function listFiles(options: { channel?: string; user?: string; types?: string; limit?: number; json?: boolean }): Promise<void> {
  const client = getClient();

  try {
    const params: Record<string, unknown> = {
      count: options.limit || 20,
    };

    if (options.channel) {
      params.channel = await resolveChannel(client, options.channel);
    }
    if (options.user) {
      params.user = await resolveUser(client, options.user);
    }
    if (options.types) {
      params.types = options.types;
    }

    const result = await client.files.list(params);
    const files = result.files || [];

    const data = files.map(f => ({
      id: f.id,
      name: f.name,
      filetype: f.filetype,
      size: f.size,
      created: f.created,
      url_private: f.url_private,
    }));

    if (options.json) {
      output(data, true);
    } else {
      console.log(chalk.bold('\nFiles:\n'));
      if (data.length === 0) {
        console.log(chalk.gray('No files found.'));
      } else {
        data.forEach(f => {
          const size = f.size ? `${Math.round((f.size as number) / 1024)}KB` : 'N/A';
          const created = f.created ? formatTimestamp(String(f.created)) : 'N/A';
          console.log(`${chalk.cyan(f.name || 'Untitled')} ${chalk.gray(`(${f.filetype || 'unknown'})`)}`);
          console.log(`  ID: ${f.id} | Size: ${size} | Created: ${created}`);
          if (f.url_private) console.log(`  URL: ${f.url_private}`);
          console.log();
        });
      }
    }
  } catch (error) {
    const err = error as Error & { data?: { error?: string; response_metadata?: { messages?: string[] } } };
    console.error(chalk.red(`Failed to list files: ${err.data?.error || err.message}`));
    if (err.data?.response_metadata?.messages) {
      err.data.response_metadata.messages.forEach((msg: string) => {
        console.error(chalk.red(`  ${msg}`));
      });
    }
    process.exit(1);
  }
}

async function getFileInfo(fileId: string, options: { json?: boolean }): Promise<void> {
  const client = getClient();

  try {
    const result = await client.files.info({ file: fileId });
    const f = result.file;

    if (!f) {
      console.error(chalk.red(`File not found: ${fileId}`));
      process.exit(1);
    }

    const data = {
      id: f.id,
      name: f.name,
      title: f.title,
      filetype: f.filetype,
      size: f.size,
      created: f.created,
      url_private: f.url_private,
      channels: f.channels,
      comments_count: f.comments_count,
    };

    if (options.json) {
      output(data, true);
    } else {
      console.log(chalk.bold(`\n${data.name || 'Untitled'}\n`));
      console.log(`ID: ${data.id}`);
      if (data.title) console.log(`Title: ${data.title}`);
      console.log(`Type: ${data.filetype || 'N/A'}`);
      console.log(`Size: ${data.size ? `${Math.round((data.size as number) / 1024)}KB` : 'N/A'}`);
      console.log(`Created: ${data.created ? formatTimestamp(String(data.created)) : 'N/A'}`);
      if (data.url_private) console.log(`URL: ${data.url_private}`);
      if (data.channels && (data.channels as string[]).length > 0) {
        console.log(`Shared to: ${(data.channels as string[]).join(', ')}`);
      }
      console.log(`Comments: ${data.comments_count ?? 0}`);
    }
  } catch (error) {
    const err = error as Error & { data?: { error?: string; response_metadata?: { messages?: string[] } } };
    console.error(chalk.red(`Failed to get file info: ${err.data?.error || err.message}`));
    if (err.data?.response_metadata?.messages) {
      err.data.response_metadata.messages.forEach((msg: string) => {
        console.error(chalk.red(`  ${msg}`));
      });
    }
    process.exit(1);
  }
}

async function deleteFile(fileId: string, options: { json?: boolean }): Promise<void> {
  const client = getClient();

  try {
    await client.files.delete({ file: fileId });

    if (options.json) {
      output({ success: true, file: fileId }, true);
    } else {
      console.log(chalk.green(`✓ Deleted file: ${fileId}`));
    }
  } catch (error) {
    const err = error as Error & { data?: { error?: string; response_metadata?: { messages?: string[] } } };
    console.error(chalk.red(`Failed to delete file: ${err.data?.error || err.message}`));
    if (err.data?.response_metadata?.messages) {
      err.data.response_metadata.messages.forEach((msg: string) => {
        console.error(chalk.red(`  ${msg}`));
      });
    }
    process.exit(1);
  }
}

// ============================================================================
// Reaction Commands
// ============================================================================

async function addReaction(channel: string, ts: string, emoji: string, options: { json?: boolean }): Promise<void> {
  const client = getClient();
  const name = emoji.replace(/^:|:$/g, '');

  try {
    const channelId = await resolveChannel(client, channel);
    await client.reactions.add({ channel: channelId, timestamp: ts, name });

    if (options.json) {
      output({ success: true, channel: channelId, ts, emoji: name }, true);
    } else {
      console.log(chalk.green(`✓ Added :${name}: reaction to message ${ts}`));
    }
  } catch (error) {
    const err = error as Error & { data?: { error?: string } };
    console.error(chalk.red(`Failed to add reaction: ${err.data?.error || err.message}`));
    process.exit(1);
  }
}

async function removeReaction(channel: string, ts: string, emoji: string, options: { json?: boolean }): Promise<void> {
  const client = getClient();
  const name = emoji.replace(/^:|:$/g, '');

  try {
    const channelId = await resolveChannel(client, channel);
    await client.reactions.remove({ channel: channelId, timestamp: ts, name });

    if (options.json) {
      output({ success: true, channel: channelId, ts, emoji: name }, true);
    } else {
      console.log(chalk.green(`✓ Removed :${name}: reaction from message ${ts}`));
    }
  } catch (error) {
    const err = error as Error & { data?: { error?: string } };
    console.error(chalk.red(`Failed to remove reaction: ${err.data?.error || err.message}`));
    process.exit(1);
  }
}

async function listReactions(user: string, options: { limit?: number; json?: boolean }): Promise<void> {
  const client = getClient();

  try {
    const userId = await resolveUser(client, user);
    const result = await client.reactions.list({
      user: userId,
      limit: options.limit || 20,
    });

    const items = result.items || [];

    if (options.json) {
      output(items, true);
    } else {
      console.log(chalk.bold(`\nReactions by ${user}:\n`));
      if (items.length === 0) {
        console.log(chalk.gray('No reactions found.'));
      } else {
        items.forEach(item => {
          const msg = item.message;
          if (msg) {
            console.log(`${chalk.gray(formatTimestamp(msg.ts))} in ${chalk.cyan(item.channel || 'unknown')}`);
            console.log(`  ${msg.text?.substring(0, 100) || '(no text)'}${(msg.text?.length || 0) > 100 ? '...' : ''}`);
            const reactions = msg.reactions || [];
            reactions.forEach(r => {
              console.log(`  :${r.name}: (${r.count}) — ${(r.users || []).join(', ')}`);
            });
            console.log();
          }
        });
      }
    }
  } catch (error) {
    const err = error as Error & { data?: { error?: string } };
    console.error(chalk.red(`Failed to list reactions: ${err.data?.error || err.message}`));
    process.exit(1);
  }
}

// ============================================================================
// Search Commands
// ============================================================================

async function searchMessages(query: string, options: { sort?: string; sortDir?: string; limit?: number; json?: boolean }): Promise<void> {
  const client = getClient();

  try {
    const result = await client.search.messages({
      query,
      sort: (options.sort || 'score') as 'score' | 'timestamp',
      sort_dir: (options.sortDir || 'desc') as 'asc' | 'desc',
      count: options.limit || 20,
    });

    const matches = result.messages?.matches || [];

    const data = matches.map(m => ({
      channel: (m.channel as { name?: string })?.name || 'N/A',
      user: m.user || m.username || 'N/A',
      text: m.text || '',
      ts: m.ts,
      permalink: m.permalink,
    }));

    if (options.json) {
      output(data, true);
    } else {
      console.log(chalk.bold(`\nSearch results for "${query}":\n`));
      if (data.length === 0) {
        console.log(chalk.gray('No messages found.'));
      } else {
        data.forEach(m => {
          const time = formatTimestamp(m.ts);
          console.log(`${chalk.gray(time)} ${chalk.cyan(`#${m.channel}`)} ${chalk.yellow(m.user)}`);
          console.log(`  ${m.text}`);
          if (m.permalink) console.log(`  ${chalk.gray(m.permalink)}`);
          console.log();
        });
        console.log(chalk.gray(`Total: ${result.messages?.total || data.length} matches`));
      }
    }
  } catch (error) {
    const err = error as Error & { data?: { error?: string } };
    const errCode = err.data?.error || err.message;
    if (errCode === 'not_allowed_token_type' || errCode === 'missing_scope') {
      console.error(chalk.red('This command requires a user token (xoxp-), not a bot token'));
      console.error(chalk.yellow('Set SLACK_TOKEN to a user OAuth token with appropriate scopes'));
    } else {
      console.error(chalk.red(`Failed to search messages: ${errCode}`));
    }
    process.exit(1);
  }
}

async function searchFiles(query: string, options: { sort?: string; sortDir?: string; limit?: number; json?: boolean }): Promise<void> {
  const client = getClient();

  try {
    const result = await client.search.files({
      query,
      sort: (options.sort || 'score') as 'score' | 'timestamp',
      sort_dir: (options.sortDir || 'desc') as 'asc' | 'desc',
      count: options.limit || 20,
    });

    const matches = result.files?.matches || [];

    const data = matches.map(f => ({
      name: f.name || 'Untitled',
      id: f.id,
      filetype: f.filetype || 'unknown',
      user: f.user || 'N/A',
      title: f.title || '',
      created: f.created,
    }));

    if (options.json) {
      output(data, true);
    } else {
      console.log(chalk.bold(`\nFile search results for "${query}":\n`));
      if (data.length === 0) {
        console.log(chalk.gray('No files found.'));
      } else {
        data.forEach(f => {
          const created = f.created ? formatTimestamp(String(f.created)) : 'N/A';
          console.log(`${chalk.cyan(f.name)} ${chalk.gray(`(${f.filetype})`)}`);
          console.log(`  ID: ${f.id} | User: ${f.user} | Created: ${created}`);
          if (f.title && f.title !== f.name) console.log(`  Title: ${f.title}`);
          console.log();
        });
        console.log(chalk.gray(`Total: ${result.files?.total || data.length} matches`));
      }
    }
  } catch (error) {
    const err = error as Error & { data?: { error?: string } };
    const errCode = err.data?.error || err.message;
    if (errCode === 'not_allowed_token_type' || errCode === 'missing_scope') {
      console.error(chalk.red('This command requires a user token (xoxp-), not a bot token'));
      console.error(chalk.yellow('Set SLACK_TOKEN to a user OAuth token with appropriate scopes'));
    } else {
      console.error(chalk.red(`Failed to search files: ${errCode}`));
    }
    process.exit(1);
  }
}

// ============================================================================
// Pin Commands
// ============================================================================

async function addPin(channel: string, ts: string, options: { json?: boolean }): Promise<void> {
  const client = getClient();

  try {
    const channelId = await resolveChannel(client, channel);
    await client.pins.add({ channel: channelId, timestamp: ts });

    if (options.json) {
      output({ success: true, channel: channelId, ts }, true);
    } else {
      console.log(chalk.green(`✓ Pinned message ${ts} in ${channel}`));
    }
  } catch (error) {
    const err = error as Error & { data?: { error?: string } };
    console.error(chalk.red(`Failed to pin message: ${err.data?.error || err.message}`));
    process.exit(1);
  }
}

async function removePin(channel: string, ts: string, options: { json?: boolean }): Promise<void> {
  const client = getClient();

  try {
    const channelId = await resolveChannel(client, channel);
    await client.pins.remove({ channel: channelId, timestamp: ts });

    if (options.json) {
      output({ success: true, channel: channelId, ts }, true);
    } else {
      console.log(chalk.green(`✓ Unpinned message ${ts} in ${channel}`));
    }
  } catch (error) {
    const err = error as Error & { data?: { error?: string } };
    console.error(chalk.red(`Failed to unpin message: ${err.data?.error || err.message}`));
    process.exit(1);
  }
}

async function listPins(channel: string, options: { json?: boolean }): Promise<void> {
  const client = getClient();

  try {
    const channelId = await resolveChannel(client, channel);
    const result = await client.pins.list({ channel: channelId });
    const items = result.items || [];

    if (options.json) {
      output(items, true);
    } else {
      console.log(chalk.bold(`\nPinned items in ${channel}:\n`));
      if (items.length === 0) {
        console.log(chalk.gray('No pinned items.'));
      } else {
        items.forEach(i => {
          const item = i as unknown as { type?: string; message?: { ts?: string; text?: string; user?: string }; file?: { name?: string; id?: string }; created?: number; created_by?: string };
          const type = item.type || 'message';
          const pinnedBy = item.created_by || 'unknown';
          const pinnedAt = item.created ? formatTimestamp(String(item.created)) : 'N/A';

          if (type === 'message' && item.message) {
            const preview = item.message.text?.substring(0, 120) || '(no text)';
            const ellipsis = (item.message.text?.length || 0) > 120 ? '...' : '';
            console.log(`${chalk.cyan('[message]')} ${chalk.gray(formatTimestamp(item.message.ts))}`);
            console.log(`  ${preview}${ellipsis}`);
          } else if (type === 'file' && item.file) {
            console.log(`${chalk.cyan('[file]')} ${item.file.name || item.file.id}`);
          } else {
            console.log(`${chalk.cyan(`[${type}]`)}`);
          }
          console.log(`  Pinned by: ${pinnedBy} on ${pinnedAt}`);
          console.log();
        });
      }
    }
  } catch (error) {
    const err = error as Error & { data?: { error?: string } };
    console.error(chalk.red(`Failed to list pins: ${err.data?.error || err.message}`));
    process.exit(1);
  }
}

// ============================================================================
// Status Commands
// ============================================================================

async function setStatus(text: string, options: { emoji?: string; expiration?: string; json?: boolean }): Promise<void> {
  const client = getClient();

  try {
    let statusEmoji = options.emoji || '';
    if (statusEmoji && !statusEmoji.startsWith(':')) {
      statusEmoji = `:${statusEmoji}:`;
    }

    let statusExpiration = 0;
    if (options.expiration) {
      statusExpiration = Math.floor(Date.now() / 1000) + parseInt(options.expiration) * 60;
    }

    await client.users.profile.set({
      profile: {
        status_text: text,
        status_emoji: statusEmoji,
        status_expiration: statusExpiration,
      },
    } as Parameters<typeof client.users.profile.set>[0]);

    if (options.json) {
      output({ success: true, status_text: text, status_emoji: statusEmoji, status_expiration: statusExpiration }, true);
    } else {
      console.log(chalk.green(`✓ Status set: ${statusEmoji ? statusEmoji + ' ' : ''}${text}`));
      if (statusExpiration > 0) {
        console.log(`  Expires: ${new Date(statusExpiration * 1000).toISOString()}`);
      }
    }
  } catch (error) {
    const err = error as Error & { data?: { error?: string } };
    const errCode = err.data?.error || err.message;
    if (errCode === 'not_allowed_token_type' || errCode === 'missing_scope') {
      console.error(chalk.red('This command requires a user token (xoxp-), not a bot token'));
      console.error(chalk.yellow('Set SLACK_TOKEN to a user OAuth token with appropriate scopes'));
    } else {
      console.error(chalk.red(`Failed to set status: ${errCode}`));
    }
    process.exit(1);
  }
}

async function clearStatus(options: { json?: boolean }): Promise<void> {
  const client = getClient();

  try {
    await client.users.profile.set({
      profile: {
        status_text: '',
        status_emoji: '',
        status_expiration: 0,
      },
    } as Parameters<typeof client.users.profile.set>[0]);

    if (options.json) {
      output({ success: true }, true);
    } else {
      console.log(chalk.green('✓ Status cleared'));
    }
  } catch (error) {
    const err = error as Error & { data?: { error?: string } };
    const errCode = err.data?.error || err.message;
    if (errCode === 'not_allowed_token_type' || errCode === 'missing_scope') {
      console.error(chalk.red('This command requires a user token (xoxp-), not a bot token'));
      console.error(chalk.yellow('Set SLACK_TOKEN to a user OAuth token with appropriate scopes'));
    } else {
      console.error(chalk.red(`Failed to clear status: ${errCode}`));
    }
    process.exit(1);
  }
}

// ============================================================================
// Emoji Commands
// ============================================================================

async function listEmoji(options: { json?: boolean }): Promise<void> {
  const client = getClient();

  try {
    const result = await client.emoji.list();
    const emojiMap = result.emoji || {};

    if (options.json) {
      output(emojiMap, true);
    } else {
      const names = Object.keys(emojiMap).sort();
      console.log(chalk.bold(`\nCustom Emoji (${names.length}):\n`));
      if (names.length === 0) {
        console.log(chalk.gray('No custom emoji found.'));
      } else {
        names.forEach(name => {
          const url = emojiMap[name];
          if (url.startsWith('alias:')) {
            console.log(`  :${name}: → ${url}`);
          } else {
            console.log(`  :${name}: — ${url}`);
          }
        });
      }
    }
  } catch (error) {
    const err = error as Error & { data?: { error?: string } };
    console.error(chalk.red(`Failed to list emoji: ${err.data?.error || err.message}`));
    process.exit(1);
  }
}

// ============================================================================
// Template Helpers
// ============================================================================

interface TemplateFrontMatter {
  name: string;
  description: string;
  [key: string]: string;
}

function getTemplatesDir(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  // When running from dist/, templates are one level up
  const candidates = [
    join(currentDir, 'slack-templates'),
    join(currentDir, '..', 'slack-templates'),
  ];
  for (const dir of candidates) {
    try {
      readdirSync(dir);
      return dir;
    } catch {
      // try next
    }
  }
  return candidates[0]; // fall through to error in caller
}

function parseFrontMatter(content: string): { frontMatter: TemplateFrontMatter | null; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { frontMatter: null, body: content };

  const yamlBlock = match[1];
  const body = match[2];

  const frontMatter: Record<string, string> = {};
  for (const line of yamlBlock.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    frontMatter[key] = value;
  }

  if (!frontMatter.name || !frontMatter.description) return { frontMatter: null, body: content };

  return {
    frontMatter: frontMatter as TemplateFrontMatter,
    body,
  };
}

function listTemplates(): void {
  const dir = getTemplatesDir();
  let files: string[];
  try {
    files = readdirSync(dir).filter(f => f.endsWith('.md'));
  } catch {
    console.error(chalk.red('No templates directory found'));
    process.exit(1);
  }

  if (files.length === 0) {
    console.log(chalk.yellow('No templates found'));
    return;
  }

  console.log(chalk.bold('\nSlack Templates\n'));

  for (const file of files) {
    const content = readFileSync(join(dir, file), 'utf-8');
    const { frontMatter } = parseFrontMatter(content);

    if (frontMatter) {
      console.log(`  ${chalk.cyan(frontMatter.name)}`);
      console.log(`  ${chalk.dim(frontMatter.description)}`);
      for (const [key, value] of Object.entries(frontMatter)) {
        if (key === 'name' || key === 'description') continue;
        console.log(`  ${chalk.dim(key + ':')} ${value}`);
      }
      console.log(`  ${chalk.dim('File:')} ${file}`);
    } else {
      console.log(`  ${chalk.cyan(file)}`);
      console.log(`  ${chalk.dim('(no front matter)')}`);
    }
    console.log();
  }
}

function viewTemplate(filename: string): void {
  const dir = getTemplatesDir();
  const filePath = join(dir, filename.endsWith('.md') ? filename : `${filename}.md`);

  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    console.error(chalk.red(`Template not found: ${filename}`));
    console.error(chalk.yellow('Run "slack-cli template list" to see available templates'));
    process.exit(1);
  }

  console.log(content);
}

// ============================================================================
// CLI Setup
// ============================================================================

const program = new Command();

program
  .name('slack-cli')
  .description('Comprehensive CLI for Slack API operations')
  .version('1.0.0');

// Channel commands
const channelCmd = program.command('channel').description('Channel operations');

channelCmd
  .command('list')
  .description('List channels')
  .addOption(
    new Option('-t, --type <type>', 'Channel type')
      .choices(['public_channel', 'private_channel', 'mpim', 'im'])
      .default('public_channel')
  )
  .option('-l, --limit <number>', 'Limit results', '100')
  .option('--exclude-archived', 'Exclude archived channels', true)
  .option('--include-archived', 'Include archived channels')
  .option('-j, --json', 'Output as JSON')
  .action((opts) => listChannels({ ...opts, limit: parseInt(opts.limit), excludeArchived: !opts.includeArchived }));

channelCmd
  .command('info <channel>')
  .description('Get channel info (name or ID)')
  .option('-j, --json', 'Output as JSON')
  .action(getChannelInfo);

channelCmd
  .command('create <name>')
  .description('Create a new channel')
  .option('-p, --private', 'Create as private channel')
  .option('-j, --json', 'Output as JSON')
  .action(createChannel);

channelCmd
  .command('archive <channel>')
  .description('Archive a channel')
  .option('-j, --json', 'Output as JSON')
  .action(archiveChannel);

channelCmd
  .command('history <channel>')
  .description('Get channel message history')
  .option('-l, --limit <number>', 'Number of messages', '20')
  .option('--oldest <date>', 'Start date (ISO format, e.g., 2024-01-01)')
  .option('--latest <date>', 'End date (ISO format, e.g., 2024-12-31)')
  .option('-j, --json', 'Output as JSON')
  .action((channel, opts) => getChannelHistory(channel, { ...opts, limit: parseInt(opts.limit) }));

channelCmd
  .command('invite <channel> <user>')
  .description('Invite a user to a channel')
  .option('-j, --json', 'Output as JSON')
  .action(inviteToChannel);

channelCmd
  .command('kick <channel> <user>')
  .description('Remove a user from a channel')
  .option('-j, --json', 'Output as JSON')
  .action(kickFromChannel);

channelCmd
  .command('set-topic <channel> <topic>')
  .description('Set channel topic')
  .option('-j, --json', 'Output as JSON')
  .action(setChannelTopic);

channelCmd
  .command('set-purpose <channel> <purpose>')
  .description('Set channel purpose')
  .option('-j, --json', 'Output as JSON')
  .action(setChannelPurpose);

// Message commands
const messageCmd = program.command('message').description('Message operations');

messageCmd
  .command('send <channel> <text>')
  .description('Send a message to a channel')
  .option('--thread-ts <ts>', 'Thread timestamp to reply to')
  .option('--blocks <json>', 'Block Kit blocks as JSON string')
  .option('-f, --file <path>', 'Attach a file (repeatable for multiple attachments)', (v: string, acc: string[]) => acc.concat([v]), [] as string[])
  .option('--no-resolve-mentions', 'Leave @handles as literal text (no notification)')
  .option('-j, --json', 'Output as JSON')
  .action(sendMessage);

messageCmd
  .command('update <channel> <ts> <text>')
  .description('Update a message')
  .option('--no-resolve-mentions', 'Leave @handles as literal text (no notification)')
  .option('-j, --json', 'Output as JSON')
  .action(updateMessage);

messageCmd
  .command('delete <channel> <ts>')
  .description('Delete a message')
  .option('-j, --json', 'Output as JSON')
  .action(deleteMessage);

messageCmd
  .command('reply <channel> <ts> <text>')
  .description('Reply to a message in a thread')
  .option('--no-resolve-mentions', 'Leave @handles as literal text (no notification)')
  .option('-j, --json', 'Output as JSON')
  .action(replyToMessage);

messageCmd
  .command('thread <channel> <ts>')
  .description('Read a thread: the parent message and all its replies (pass the parent\'s ts — a reply\'s ts returns only that reply)')
  .option('-l, --limit <number>', 'Max messages to fetch, parent included', '1000')
  .option('-j, --json', 'Output as JSON')
  .action((channel, ts, opts) => getThread(channel, ts, { ...opts, limit: parseInt(opts.limit) }));

// User commands
const userCmd = program.command('user').description('User operations');

userCmd
  .command('list')
  .description('List workspace users')
  .option('-l, --limit <number>', 'Limit results', '100')
  .option('-j, --json', 'Output as JSON')
  .action((opts) => listUsers({ ...opts, limit: parseInt(opts.limit) }));

userCmd
  .command('info <user>')
  .description('Get user info (name, email, or ID)')
  .option('-j, --json', 'Output as JSON')
  .action(getUserInfo);

userCmd
  .command('presence <user>')
  .description('Get user presence/status')
  .option('-j, --json', 'Output as JSON')
  .action(getUserPresence);

userCmd
  .command('me')
  .description('Get current authenticated user')
  .option('-j, --json', 'Output as JSON')
  .action(getMe);

// User group commands (read-only)
const usergroupCmd = program.command('usergroup').description('User group operations (read-only)');

usergroupCmd
  .command('list')
  .description('List workspace user groups')
  .option('--include-disabled', 'Include disabled groups')
  .option('-j, --json', 'Output as JSON')
  .action(listUserGroups);

usergroupCmd
  .command('info <group>')
  .description('Get user group info (handle, name, or ID)')
  .option('-j, --json', 'Output as JSON')
  .action(getUserGroupInfo);

usergroupCmd
  .command('users <group>')
  .description('List members of a user group')
  .option('-j, --json', 'Output as JSON')
  .action(listUserGroupUsers);

// File commands
const fileCmd = program.command('file').description('File operations');

fileCmd
  .command('upload <channel> <files...>')
  .description('Upload one or more files to a channel')
  .option('--title <title>', 'File title (only applied when uploading a single file)')
  .option('--comment <text>', 'Initial comment')
  .option('--thread-ts <ts>', 'Thread timestamp to attach within a thread')
  .option('-j, --json', 'Output as JSON')
  .action(uploadFile);

fileCmd
  .command('list')
  .description('List files')
  .option('-c, --channel <channel>', 'Filter by channel')
  .option('-u, --user <user>', 'Filter by user')
  .option('--types <types>', 'Filter by file types (comma-separated)')
  .option('-l, --limit <number>', 'Limit results', '20')
  .option('-j, --json', 'Output as JSON')
  .action((opts) => listFiles({ ...opts, limit: parseInt(opts.limit) }));

fileCmd
  .command('info <file>')
  .description('Get file info')
  .option('-j, --json', 'Output as JSON')
  .action(getFileInfo);

fileCmd
  .command('delete <file>')
  .description('Delete a file')
  .option('-j, --json', 'Output as JSON')
  .action(deleteFile);

// Reaction commands
const reactionCmd = program.command('reaction').description('Reaction operations');

reactionCmd
  .command('add <channel> <ts> <emoji>')
  .description('Add a reaction to a message')
  .option('-j, --json', 'Output as JSON')
  .action(addReaction);

reactionCmd
  .command('remove <channel> <ts> <emoji>')
  .description('Remove a reaction from a message')
  .option('-j, --json', 'Output as JSON')
  .action(removeReaction);

reactionCmd
  .command('list <user>')
  .description('List reactions by a user')
  .option('-l, --limit <number>', 'Limit results', '20')
  .option('-j, --json', 'Output as JSON')
  .action((user, opts) => listReactions(user, { ...opts, limit: parseInt(opts.limit) }));

// Search commands
const searchCmd = program.command('search').description('Search operations');

searchCmd
  .command('messages <query>')
  .description('Search messages')
  .addOption(
    new Option('-s, --sort <field>', 'Sort field')
      .choices(['score', 'timestamp'])
      .default('score')
  )
  .addOption(
    new Option('--sort-dir <direction>', 'Sort direction')
      .choices(['asc', 'desc'])
      .default('desc')
  )
  .option('-l, --limit <number>', 'Limit results', '20')
  .option('-j, --json', 'Output as JSON')
  .action((query, opts) => searchMessages(query, { ...opts, limit: parseInt(opts.limit) }));

searchCmd
  .command('files <query>')
  .description('Search files')
  .addOption(
    new Option('-s, --sort <field>', 'Sort field')
      .choices(['score', 'timestamp'])
      .default('score')
  )
  .addOption(
    new Option('--sort-dir <direction>', 'Sort direction')
      .choices(['asc', 'desc'])
      .default('desc')
  )
  .option('-l, --limit <number>', 'Limit results', '20')
  .option('-j, --json', 'Output as JSON')
  .action((query, opts) => searchFiles(query, { ...opts, limit: parseInt(opts.limit) }));

// Pin commands
const pinCmd = program.command('pin').description('Pin operations');

pinCmd
  .command('add <channel> <ts>')
  .description('Pin a message')
  .option('-j, --json', 'Output as JSON')
  .action(addPin);

pinCmd
  .command('remove <channel> <ts>')
  .description('Unpin a message')
  .option('-j, --json', 'Output as JSON')
  .action(removePin);

pinCmd
  .command('list <channel>')
  .description('List pinned items in a channel')
  .option('-j, --json', 'Output as JSON')
  .action(listPins);

// Status commands
const statusCmd = program.command('status').description('Status operations');

statusCmd
  .command('set <text>')
  .description('Set your status')
  .option('-e, --emoji <emoji>', 'Status emoji (e.g., :coffee:)')
  .option('--expiration <minutes>', 'Auto-clear after N minutes')
  .option('-j, --json', 'Output as JSON')
  .action(setStatus);

statusCmd
  .command('clear')
  .description('Clear your status')
  .option('-j, --json', 'Output as JSON')
  .action(clearStatus);

// Emoji commands
const emojiCmd = program.command('emoji').description('Emoji operations');

emojiCmd
  .command('list')
  .description('List custom emoji')
  .option('-j, --json', 'Output as JSON')
  .action(listEmoji);

// Template commands
const templateCmd = program.command('template').description('Slack message template operations');

templateCmd
  .command('list')
  .description('List available Slack message templates')
  .action(listTemplates);

templateCmd
  .command('view <filename>')
  .description('View a Slack message template')
  .action(viewTemplate);

program.parse();
