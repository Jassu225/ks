#!/usr/bin/env npx tsx
/**
 * Linear CLI - A comprehensive command-line interface for the Linear API
 * Uses the official @linear/sdk for all operations
 *
 * Usage: npx tsx linear-cli.ts <command> [options]
 *
 * Environment: LINEAR_API_KEY must be set (loaded from .env file)
 */

import { LinearClient, Issue, Project, Team, User, Document, Comment, IssueLabel, Cycle } from '@linear/sdk';
import { Command, Option } from 'commander';
import chalk from 'chalk';

import { loadEnv } from './lib/env.js';
import { getLinearClient } from './lib/linear-client.js';

loadEnv();

// Mimics @linear/sdk ProjectUpdateHealthType - SDK only exports as type, not runtime value
enum ProjectUpdateHealthType {
  AtRisk = 'atRisk',
  OffTrack = 'offTrack',
  OnTrack = 'onTrack'
}

// ============================================================================
// Client Initialization
// ============================================================================

function getClient(): LinearClient {
  return getLinearClient();
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

// ============================================================================
// Project Commands
// ============================================================================

async function listProjects(options: { team?: string; limit?: number; json?: boolean }): Promise<void> {
  const client = getClient();
  const projects = await client.projects({
    first: options.limit || 50,
    // Note: team filtering done client-side as SDK filter types are limited
  });

  const data = await Promise.all(projects.nodes.map(async (p) => {
    const lead = await p.lead;
    const status = await p.status;
    return {
      id: p.id,
      name: p.name,
      slugId: p.slugId,
      url: p.url,
      status: status?.name || 'Unknown',
      lead: lead?.name || 'Unassigned',
      startDate: p.startDate,
      targetDate: p.targetDate,
      progress: p.progress,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt
    };
  }));

  if (options.json) {
    output(data, true);
  } else {
    console.log(chalk.bold('\nProjects:\n'));
    data.forEach(p => {
      console.log(`${chalk.cyan(p.name)}`);
      console.log(`  ID: ${p.id}`);
      console.log(`  URL: ${p.url}`);
      console.log(`  Status: ${p.status} | Lead: ${p.lead}`);
      console.log(`  Progress: ${Math.round((p.progress || 0) * 100)}%`);
      console.log();
    });
  }
}

async function getProject(idOrSlug: string, options: { json?: boolean }): Promise<void> {
  const client = getClient();

  // Try to find by ID first, then by slug
  let project: Project | undefined;

  try {
    project = await client.project(idOrSlug);
  } catch {
    // Try searching by name/slug
    const projects = await client.projects({
      filter: { slugId: { eq: idOrSlug } }
    });
    project = projects.nodes[0];
  }

  if (!project) {
    console.error(chalk.red(`Project not found: ${idOrSlug}`));
    process.exit(1);
  }

  const lead = await project.lead;
  const status = await project.status;
  const teams = await project.teams();
  const initiatives = await project.initiatives();

  const data = {
    id: project.id,
    name: project.name,
    slugId: project.slugId,
    url: project.url,
    description: project.description,
    content: project.content,
    status: status ? { id: status.id, name: status.name } : null,
    lead: lead ? { id: lead.id, name: lead.name, email: lead.email } : null,
    teams: teams.nodes.map(t => ({ id: t.id, name: t.name, key: t.key })),
    initiatives: initiatives.nodes.map(i => ({ id: i.id, name: i.name })),
    priority: project.priority,
    progress: project.progress,
    startDate: project.startDate,
    targetDate: project.targetDate,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt
  };

  if (options.json) {
    output(data, true);
  } else {
    console.log(chalk.bold(`\n${data.name}\n`));
    console.log(`ID: ${data.id}`);
    console.log(`URL: ${data.url}`);
    console.log(`Status: ${data.status?.name || 'Unknown'}`);
    console.log(`Lead: ${data.lead?.name || 'Unassigned'}`);
    console.log(`Priority: ${data.priority || 'None'}`);
    console.log(`Progress: ${Math.round((data.progress || 0) * 100)}%`);
    console.log(`Start: ${formatDate(data.startDate)} | Target: ${formatDate(data.targetDate)}`);
    if (data.description) {
      console.log(`\nSummary:\n${data.description}`);
    }
    if (data.content) {
      console.log(`\nDescription:\n${data.content}`);
    }
  }
}

async function getProjectFromUrl(url: string, options: { json?: boolean }): Promise<void> {
  // Parse Linear project URL: https://linear.app/{workspace}/project/{slug}-{id}
  const match = url.match(/linear\.app\/[^\/]+\/project\/([^\/]+)/);
  if (!match) {
    console.error(chalk.red('Invalid Linear project URL'));
    process.exit(1);
  }

  const slugWithId = match[1];
  // The ID is the last part after the last dash (UUID format)
  const idMatch = slugWithId.match(/([a-f0-9]{8,}[a-f0-9-]*)$/i);
  const projectId = idMatch ? idMatch[1] : slugWithId;

  await getProject(projectId, options);
}

async function resolveProjectId(client: LinearClient, idOrSlugOrUrl: string): Promise<string> {
  // Check if it's a URL
  const urlMatch = idOrSlugOrUrl.match(/linear\.app\/[^\/]+\/project\/([^\/]+)/);
  if (urlMatch) {
    const slugWithId = urlMatch[1];
    const idMatch = slugWithId.match(/([a-f0-9]{8,}[a-f0-9-]*)$/i);
    return idMatch ? idMatch[1] : slugWithId;
  }

  // Try to find by ID first, then by slug
  try {
    const project = await client.project(idOrSlugOrUrl);
    return project.id;
  } catch {
    // Try searching by slug
    const projects = await client.projects({
      filter: { slugId: { eq: idOrSlugOrUrl } }
    });
    if (projects.nodes[0]) {
      return projects.nodes[0].id;
    }
  }

  throw new Error(`Project not found: ${idOrSlugOrUrl}`);
}

async function listProjectUpdates(projectIdOrSlug: string, options: { limit?: number; json?: boolean }): Promise<void> {
  const client = getClient();

  let projectId: string;
  try {
    projectId = await resolveProjectId(client, projectIdOrSlug);
  } catch (e) {
    console.error(chalk.red((e as Error).message));
    process.exit(1);
  }

  const project = await client.project(projectId);
  const updates = await project.projectUpdates({
    first: options.limit || 20
  });

  const data = await Promise.all(updates.nodes.map(async (u) => {
    const user = await u.user;
    return {
      id: u.id,
      body: u.body,
      health: u.health,
      user: user ? { id: user.id, name: user.name } : null,
      createdAt: u.createdAt,
      updatedAt: u.updatedAt,
      url: u.url
    };
  }));

  if (options.json) {
    output(data, true);
  } else {
    console.log(chalk.bold(`\nProject Updates for ${project.name}:\n`));
    if (data.length === 0) {
      console.log(chalk.gray('No updates found.'));
    } else {
      data.forEach(u => {
        const healthIcon = u.health === 'onTrack' ? chalk.green('●') :
                           u.health === 'atRisk' ? chalk.yellow('●') :
                           u.health === 'offTrack' ? chalk.red('●') : chalk.gray('○');
        console.log(`${healthIcon} ${chalk.cyan(formatDate(u.createdAt))} by ${u.user?.name || 'Unknown'}`);
        console.log(`  ${u.body?.substring(0, 200)}${(u.body?.length || 0) > 200 ? '...' : ''}`);
        console.log(`  URL: ${u.url}`);
        console.log();
      });
    }
  }
}

async function createProjectUpdate(projectIdOrSlug: string, options: {
  body: string;
  health?: ProjectUpdateHealthType;
  attachments?: string[];
  json?: boolean;
}): Promise<void> {
  const client = getClient();

  let projectId: string;
  try {
    projectId = await resolveProjectId(client, projectIdOrSlug);
  } catch (e) {
    console.error(chalk.red((e as Error).message));
    process.exit(1);
  }

  // Append attachments section to body if provided
  let body = options.body;
  if (options.attachments && options.attachments.length > 0) {
    const links = options.attachments.map(a => {
      const sepIdx = a.indexOf('|');
      if (sepIdx === -1) {
        console.error(chalk.red(`Invalid attachment format: "${a}". Use "Title|URL".`));
        process.exit(1);
      }
      const title = a.substring(0, sepIdx).trim();
      const url = a.substring(sepIdx + 1).trim();
      return `- [${title}](${url})`;
    });
    body += `\n\n---\n**Attachments**\n${links.join('\n')}`;
  }

  let result;
  try {
    result = await client.createProjectUpdate({
      projectId,
      body,
      health: options.health
    });
  } catch (e: unknown) {
    const err = e as Error & { errors?: Array<{ message: string }> };
    console.error(chalk.red('Failed to create project update:'));
    console.error(chalk.red(err.message));
    if (err.errors) {
      err.errors.forEach((error) => {
        console.error(chalk.red(`  - ${error.message}`));
      });
    }
    process.exit(1);
  }

  const update = await result.projectUpdate;

  if (!update) {
    console.error(chalk.red('Failed to create project update'));
    process.exit(1);
  }

  const project = await client.project(projectId);

  const data = {
    id: update.id,
    projectId: projectId,
    projectName: project.name,
    body: update.body,
    health: update.health,
    url: update.url,
    createdAt: update.createdAt
  };

  if (options.json) {
    output(data, true);
  } else {
    const healthIcon = data.health === 'onTrack' ? chalk.green('●') :
                       data.health === 'atRisk' ? chalk.yellow('●') :
                       data.health === 'offTrack' ? chalk.red('●') : chalk.gray('○');
    console.log(chalk.green(`\n✓ Created project update for ${data.projectName}`));
    console.log(`  Health: ${healthIcon} ${data.health || 'Not set'}`);
    console.log(`  URL: ${data.url}`);
  }
}

async function editProject(projectIdOrSlug: string, options: {
  name?: string;
  description?: string;
  content?: string;
  lead?: string;
  priority?: number;
  startDate?: string;
  targetDate?: string;
  color?: string;
  icon?: string;
  json?: boolean;
}): Promise<void> {
  const client = getClient();

  let projectId: string;
  try {
    projectId = await resolveProjectId(client, projectIdOrSlug);
  } catch (e) {
    console.error(chalk.red((e as Error).message));
    process.exit(1);
  }

  const updateInput: Record<string, unknown> = {};
  if (options.name) updateInput.name = options.name;
  if (options.description !== undefined) updateInput.description = options.description.replace(/\\n/g, '\n');
  if (options.content !== undefined) updateInput.content = options.content.replace(/\\n/g, '\n');
  if (options.priority !== undefined) updateInput.priority = options.priority;
  if (options.startDate) updateInput.startDate = options.startDate;
  if (options.targetDate) updateInput.targetDate = options.targetDate;
  if (options.color) updateInput.color = options.color;
  if (options.icon) updateInput.icon = options.icon;

  if (options.lead) {
    if (options.lead === 'me') {
      const me = await client.viewer;
      updateInput.leadId = me.id;
    } else if (options.lead === 'none') {
      updateInput.leadId = null;
    } else {
      updateInput.leadId = options.lead;
    }
  }

  if (Object.keys(updateInput).length === 0) {
    console.error(chalk.red('No update fields provided'));
    process.exit(1);
  }

  try {
    // Use raw GraphQL because the SDK types don't expose the 'content' field
    // on ProjectUpdateInput, even though the API accepts it
    await client.client.rawRequest(
      `mutation ProjectUpdate($id: String!, $input: ProjectUpdateInput!) {
        projectUpdate(id: $id, input: $input) {
          success
        }
      }`,
      { id: projectId, input: updateInput }
    );
  } catch (e: unknown) {
    const err = e as Error & { errors?: Array<{ message: string }> };
    console.error(chalk.red('Failed to update project:'));
    console.error(chalk.red(err.message));
    if (err.errors) {
      err.errors.forEach((error) => {
        console.error(chalk.red(`  - ${error.message}`));
      });
    }
    process.exit(1);
  }

  const project = await client.project(projectId);

  if (options.json) {
    output({ success: true, id: projectId, name: project.name }, true);
  } else {
    console.log(chalk.green(`✓ Updated project: ${project.name}`));
    console.log(`  URL: ${project.url}`);
  }
}

// ============================================================================
// Issue Commands
// ============================================================================

async function listIssues(options: {
  project?: string;
  team?: string;
  assignee?: string;
  state?: string;
  limit?: number;
  json?: boolean
}): Promise<void> {
  const client = getClient();

  const filter: Record<string, unknown> = {};
  if (options.project) {
    filter.project = { id: { eq: options.project } };
  }
  if (options.team) {
    filter.team = { key: { eq: options.team } };
  }
  if (options.assignee) {
    if (options.assignee === 'me') {
      const me = await client.viewer;
      filter.assignee = { id: { eq: me.id } };
    } else {
      filter.assignee = { id: { eq: options.assignee } };
    }
  }
  if (options.state) {
    filter.state = { name: { eq: options.state } };
  }

  const issues = await client.issues({
    first: options.limit || 50,
    filter: Object.keys(filter).length > 0 ? filter : undefined
  });

  const data = await Promise.all(issues.nodes.map(async (i) => {
    const assignee = await i.assignee;
    const state = await i.state;
    const project = await i.project;
    const labels = await i.labels();

    return {
      id: i.id,
      identifier: i.identifier,
      title: i.title,
      url: i.url,
      state: state?.name || 'Unknown',
      assignee: assignee?.name || 'Unassigned',
      project: project?.name || null,
      priority: i.priority,
      labels: labels.nodes.map(l => l.name),
      createdAt: i.createdAt,
      updatedAt: i.updatedAt
    };
  }));

  if (options.json) {
    output(data, true);
  } else {
    console.log(chalk.bold('\nIssues:\n'));
    data.forEach(i => {
      const priorityIcon = ['⬜', '🔴', '🟠', '🟡', '🟢'][i.priority || 0];
      console.log(`${chalk.cyan(i.identifier)} ${i.title}`);
      console.log(`  ${priorityIcon} ${i.state} | ${i.assignee}`);
      if (i.labels.length > 0) {
        console.log(`  Labels: ${i.labels.join(', ')}`);
      }
      console.log();
    });
  }
}

async function getIssue(identifier: string, options: { json?: boolean; full?: boolean }): Promise<void> {
  const client = getClient();

  // identifier could be like "KAR-123" or a UUID
  let issue: Issue | undefined;

  // Parse identifier (e.g., "KAR-123") to get team key and number
  const match = identifier.toUpperCase().match(/^([A-Z]+)-(\d+)$/);
  if (match) {
    const [, teamKey, numStr] = match;
    const issueNumber = parseInt(numStr, 10);
    const issues = await client.issues({
      filter: {
        team: { key: { eq: teamKey } },
        number: { eq: issueNumber }
      }
    });
    issue = issues.nodes[0];
  }

  if (!issue) {
    // Try by ID
    try {
      issue = await client.issue(identifier);
    } catch {
      console.error(chalk.red(`Issue not found: ${identifier}`));
      process.exit(1);
    }
  }

  if (!issue) {
    console.error(chalk.red(`Issue not found: ${identifier}`));
    process.exit(1);
  }

  const assignee = await issue.assignee;
  const state = await issue.state;
  const project = await issue.project;
  const labels = await issue.labels();
  const parent = await issue.parent;
  const children = await issue.children();
  const comments = options.full ? await issue.comments() : null;
  const attachments = options.full ? await issue.attachments() : null;

  const data = {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    url: issue.url,
    description: issue.description,
    state: state ? { id: state.id, name: state.name, type: state.type } : null,
    assignee: assignee ? { id: assignee.id, name: assignee.name, email: assignee.email } : null,
    project: project ? { id: project.id, name: project.name } : null,
    labels: labels.nodes.map(l => ({ id: l.id, name: l.name })),
    priority: issue.priority,
    estimate: issue.estimate,
    parent: parent ? { id: parent.id, identifier: parent.identifier, title: parent.title } : null,
    children: children.nodes.map(c => ({ id: c.id, identifier: c.identifier, title: c.title })),
    comments: comments ? comments.nodes.map(c => ({ id: c.id, body: c.body, createdAt: c.createdAt })) : undefined,
    attachments: attachments ? attachments.nodes.map(a => ({ id: a.id, title: a.title, subtitle: a.subtitle, url: a.url, sourceType: a.sourceType, metadata: a.metadata, createdAt: a.createdAt })) : undefined,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    completedAt: issue.completedAt,
    canceledAt: issue.canceledAt
  };

  if (options.json) {
    output(data, true);
  } else {
    console.log(chalk.bold(`\n${data.identifier}: ${data.title}\n`));
    console.log(`URL: ${data.url}`);
    console.log(`Status: ${data.state?.name || 'Unknown'}`);
    console.log(`Assignee: ${data.assignee?.name || 'Unassigned'}`);
    console.log(`Project: ${data.project?.name || 'None'}`);
    console.log(`Priority: ${data.priority || 'None'}`);
    if (data.labels.length > 0) {
      console.log(`Labels: ${data.labels.map(l => l.name).join(', ')}`);
    }
    if (data.description) {
      console.log(`\nDescription:\n${data.description}`);
    }
    if (data.attachments && data.attachments.length > 0) {
      console.log(chalk.bold(`\nAttachments (${data.attachments.length}):`));
      for (const a of data.attachments) {
        console.log(`  - ${a.title}${a.subtitle ? ` (${a.subtitle})` : ''}`);
        console.log(`    URL: ${a.url}`);
        if (a.sourceType) console.log(`    Source: ${a.sourceType}`);
      }
    }
  }
}

async function createIssue(options: {
  title: string;
  team: string;
  description?: string;
  project?: string;
  assignee?: string;
  state?: string;
  priority?: number;
  estimate?: number;
  labels?: string[];
  parent?: string;
  json?: boolean;
}): Promise<void> {
  const client = getClient();

  // Resolve team
  const teams = await client.teams({ filter: { key: { eq: options.team } } });
  const team = teams.nodes[0];
  if (!team) {
    console.error(chalk.red(`Team not found: ${options.team}`));
    process.exit(1);
  }

  // Build create input with proper typing
  let assigneeId: string | undefined;
  if (options.assignee) {
    if (options.assignee === 'me') {
      const me = await client.viewer;
      assigneeId = me.id;
    } else {
      assigneeId = options.assignee;
    }
  }

  const result = await client.createIssue({
    title: options.title,
    teamId: team.id,
    description: options.description,
    projectId: options.project,
    priority: options.priority,
    estimate: options.estimate,
    parentId: options.parent,
    assigneeId,
    labelIds: options.labels
  });
  const issue = await result.issue;

  if (!issue) {
    console.error(chalk.red('Failed to create issue'));
    process.exit(1);
  }

  const data = {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    url: issue.url
  };

  if (options.json) {
    output(data, true);
  } else {
    console.log(chalk.green(`\nCreated issue: ${data.identifier}`));
    console.log(`URL: ${data.url}`);
  }
}

async function updateIssue(identifier: string, options: {
  title?: string;
  description?: string;
  state?: string;
  assignee?: string;
  priority?: number;
  estimate?: number;
  project?: string;
  json?: boolean;
}): Promise<void> {
  const client = getClient();

  // Find the issue by parsing identifier (e.g., "KAR-123")
  let issue: Issue | undefined;
  const match = identifier.toUpperCase().match(/^([A-Z]+)-(\d+)$/);
  if (match) {
    const [, teamKey, numStr] = match;
    const issueNumber = parseInt(numStr, 10);
    const issues = await client.issues({
      filter: {
        team: { key: { eq: teamKey } },
        number: { eq: issueNumber }
      }
    });
    issue = issues.nodes[0];
  }

  if (!issue) {
    console.error(chalk.red(`Issue not found: ${identifier}`));
    process.exit(1);
  }

  const updateInput: Record<string, unknown> = {};
  if (options.title) updateInput.title = options.title;
  if (options.description) updateInput.description = options.description;
  if (options.priority !== undefined) updateInput.priority = options.priority;
  if (options.estimate !== undefined) updateInput.estimate = options.estimate;
  if (options.project) updateInput.projectId = options.project;

  if (options.state) {
    const team = await issue.team;
    if (team) {
      const states = await team.states();
      const state = states.nodes.find(s => s.name.toLowerCase() === options.state?.toLowerCase());
      if (state) {
        updateInput.stateId = state.id;
      }
    }
  }

  if (options.assignee) {
    if (options.assignee === 'me') {
      const me = await client.viewer;
      updateInput.assigneeId = me.id;
    } else if (options.assignee === 'none') {
      updateInput.assigneeId = null;
    } else {
      updateInput.assigneeId = options.assignee;
    }
  }

  await client.updateIssue(issue.id, updateInput);

  if (options.json) {
    output({ success: true, identifier: issue.identifier }, true);
  } else {
    console.log(chalk.green(`Updated issue: ${issue.identifier}`));
  }
}

// ============================================================================
// Team Commands
// ============================================================================

async function listTeams(options: { json?: boolean }): Promise<void> {
  const client = getClient();
  const teams = await client.teams();

  const data = teams.nodes.map(t => ({
    id: t.id,
    name: t.name,
    key: t.key,
    description: t.description
  }));

  if (options.json) {
    output(data, true);
  } else {
    console.log(chalk.bold('\nTeams:\n'));
    data.forEach(t => {
      console.log(`${chalk.cyan(t.key)} - ${t.name}`);
      if (t.description) {
        console.log(`  ${t.description}`);
      }
    });
  }
}

async function getTeam(keyOrId: string, options: { json?: boolean }): Promise<void> {
  const client = getClient();

  const teams = await client.teams({ filter: { key: { eq: keyOrId.toUpperCase() } } });
  let team = teams.nodes[0];

  if (!team) {
    try {
      team = await client.team(keyOrId);
    } catch {
      console.error(chalk.red(`Team not found: ${keyOrId}`));
      process.exit(1);
    }
  }

  const members = await team.members();
  const states = await team.states();

  const data = {
    id: team.id,
    name: team.name,
    key: team.key,
    description: team.description,
    members: members.nodes.map(m => ({ id: m.id, name: m.name, email: m.email })),
    states: states.nodes.map(s => ({ id: s.id, name: s.name, type: s.type }))
  };

  if (options.json) {
    output(data, true);
  } else {
    console.log(chalk.bold(`\n${data.key} - ${data.name}\n`));
    console.log(`Members: ${data.members.map(m => m.name).join(', ')}`);
    console.log(`States: ${data.states.map(s => s.name).join(', ')}`);
  }
}

// ============================================================================
// User Commands
// ============================================================================

async function listUsers(options: { team?: string; json?: boolean }): Promise<void> {
  const client = getClient();
  const users = await client.users();

  const data = users.nodes.map(u => ({
    id: u.id,
    name: u.name,
    email: u.email,
    displayName: u.displayName,
    active: u.active
  }));

  if (options.json) {
    output(data, true);
  } else {
    console.log(chalk.bold('\nUsers:\n'));
    data.forEach(u => {
      const status = u.active ? chalk.green('●') : chalk.gray('○');
      console.log(`${status} ${u.name} <${u.email}>`);
    });
  }
}

async function getMe(options: { json?: boolean }): Promise<void> {
  const client = getClient();
  const me = await client.viewer;

  const data = {
    id: me.id,
    name: me.name,
    email: me.email,
    displayName: me.displayName,
    active: me.active,
    admin: me.admin
  };

  if (options.json) {
    output(data, true);
  } else {
    console.log(chalk.bold(`\n${data.name}\n`));
    console.log(`Email: ${data.email}`);
    console.log(`ID: ${data.id}`);
    console.log(`Admin: ${data.admin ? 'Yes' : 'No'}`);
  }
}

// ============================================================================
// Document Commands
// ============================================================================

async function listDocuments(options: { project?: string; limit?: number; json?: boolean }): Promise<void> {
  const client = getClient();

  const filter: Record<string, unknown> = {};
  if (options.project) {
    filter.project = { id: { eq: options.project } };
  }

  const documents = await client.documents({
    first: options.limit || 50,
    filter: Object.keys(filter).length > 0 ? filter : undefined
  });

  const data = await Promise.all(documents.nodes.map(async (d) => {
    const project = await d.project;
    const creator = await d.creator;
    return {
      id: d.id,
      title: d.title,
      slugId: d.slugId,
      url: d.url,
      project: project ? { id: project.id, name: project.name } : null,
      creator: creator ? { id: creator.id, name: creator.name } : null,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt
    };
  }));

  if (options.json) {
    output(data, true);
  } else {
    console.log(chalk.bold('\nDocuments:\n'));
    data.forEach(d => {
      console.log(`${chalk.cyan(d.title)}`);
      console.log(`  ID: ${d.id}`);
      console.log(`  Project: ${d.project?.name || 'None'}`);
      console.log(`  URL: ${d.url}`);
      console.log();
    });
  }
}

async function getDocument(idOrSlug: string, options: { json?: boolean }): Promise<void> {
  const client = getClient();

  let document: Document | undefined;
  try {
    document = await client.document(idOrSlug);
  } catch {
    console.error(chalk.red(`Document not found: ${idOrSlug}`));
    process.exit(1);
  }

  const project = await document.project;
  const creator = await document.creator;

  const data = {
    id: document.id,
    title: document.title,
    slugId: document.slugId,
    url: document.url,
    content: document.content,
    project: project ? { id: project.id, name: project.name } : null,
    creator: creator ? { id: creator.id, name: creator.name } : null,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt
  };

  if (options.json) {
    output(data, true);
  } else {
    console.log(chalk.bold(`\n${data.title}\n`));
    console.log(`ID: ${data.id}`);
    console.log(`URL: ${data.url}`);
    console.log(`Project: ${data.project?.name || 'None'}`);
    if (data.content) {
      console.log(`\nContent:\n${data.content}`);
    }
  }
}

async function createDocument(options: {
  title: string;
  content?: string;
  project?: string;
  icon?: string;
  color?: string;
  json?: boolean;
}): Promise<void> {
  const client = getClient();

  const input: Record<string, unknown> = {
    title: options.title,
  };
  if (options.content) input.content = options.content.replace(/\\n/g, '\n');
  if (options.project) input.projectId = options.project;
  if (options.icon) input.icon = options.icon;
  if (options.color) input.color = options.color;

  let result;
  try {
    result = await client.createDocument(input as Parameters<typeof client.createDocument>[0]);
  } catch (e: unknown) {
    const err = e as Error & { errors?: Array<{ message: string }> };
    console.error(chalk.red('Failed to create document:'));
    console.error(chalk.red(err.message));
    if (err.errors) {
      err.errors.forEach((error) => {
        console.error(chalk.red(`  - ${error.message}`));
      });
    }
    process.exit(1);
  }

  const document = await result.document;

  if (!document) {
    console.error(chalk.red('Failed to create document'));
    process.exit(1);
  }

  const project = await document.project;

  const data = {
    id: document.id,
    title: document.title,
    slugId: document.slugId,
    url: document.url,
    project: project ? { id: project.id, name: project.name } : null,
    createdAt: document.createdAt,
  };

  if (options.json) {
    output(data, true);
  } else {
    console.log(chalk.green(`\n✓ Created document: ${data.title}`));
    console.log(`  ID: ${data.id}`);
    if (data.project) {
      console.log(`  Project: ${data.project.name}`);
    }
    console.log(`  URL: ${data.url}`);
  }
}

async function updateDocument(idOrSlug: string, options: {
  title?: string;
  content?: string;
  project?: string;
  icon?: string;
  color?: string;
  json?: boolean;
}): Promise<void> {
  const client = getClient();

  let document: Document | undefined;
  try {
    document = await client.document(idOrSlug);
  } catch {
    console.error(chalk.red(`Document not found: ${idOrSlug}`));
    process.exit(1);
  }

  const updateInput: Record<string, unknown> = {};
  if (options.title) updateInput.title = options.title;
  if (options.content) updateInput.content = options.content.replace(/\\n/g, '\n');
  if (options.project) updateInput.projectId = options.project;
  if (options.icon) updateInput.icon = options.icon;
  if (options.color) updateInput.color = options.color;

  if (Object.keys(updateInput).length === 0) {
    console.error(chalk.red('No update fields provided'));
    process.exit(1);
  }

  try {
    await client.updateDocument(document.id, updateInput as Parameters<typeof client.updateDocument>[1]);
  } catch (e: unknown) {
    const err = e as Error & { errors?: Array<{ message: string }> };
    console.error(chalk.red('Failed to update document:'));
    console.error(chalk.red(err.message));
    if (err.errors) {
      err.errors.forEach((error) => {
        console.error(chalk.red(`  - ${error.message}`));
      });
    }
    process.exit(1);
  }

  if (options.json) {
    output({ success: true, id: document.id, title: document.title }, true);
  } else {
    console.log(chalk.green(`✓ Updated document: ${document.title}`));
    console.log(`  URL: ${document.url}`);
  }
}

async function deleteDocument(id: string, options: { json?: boolean }): Promise<void> {
  const client = getClient();

  let document: Document | undefined;
  try {
    document = await client.document(id);
  } catch {
    console.error(chalk.red(`Document not found: ${id}`));
    process.exit(1);
  }

  const title = document.title;

  try {
    await client.deleteDocument(id);
  } catch (e: unknown) {
    const err = e as Error & { errors?: Array<{ message: string }> };
    console.error(chalk.red('Failed to delete document:'));
    console.error(chalk.red(err.message));
    if (err.errors) {
      err.errors.forEach((error) => {
        console.error(chalk.red(`  - ${error.message}`));
      });
    }
    process.exit(1);
  }

  if (options.json) {
    output({ success: true, id, title }, true);
  } else {
    console.log(chalk.green(`✓ Deleted document: ${title}`));
  }
}

// ============================================================================
// Label Commands
// ============================================================================

async function listLabels(options: { team?: string; json?: boolean }): Promise<void> {
  const client = getClient();

  const filter: Record<string, unknown> = {};
  if (options.team) {
    filter.team = { key: { eq: options.team } };
  }

  const labels = await client.issueLabels({
    filter: Object.keys(filter).length > 0 ? filter : undefined
  });

  const data = labels.nodes.map(l => ({
    id: l.id,
    name: l.name,
    color: l.color,
    description: l.description
  }));

  if (options.json) {
    output(data, true);
  } else {
    console.log(chalk.bold('\nLabels:\n'));
    data.forEach(l => {
      console.log(`${chalk.hex(l.color || '#888')('●')} ${l.name}`);
      if (l.description) {
        console.log(`  ${l.description}`);
      }
    });
  }
}

// ============================================================================
// Attachment Commands
// ============================================================================

async function getAttachments(identifier: string, options: { json?: boolean }): Promise<void> {
  const client = getClient();
  const issue = await findIssueByIdentifier(client, identifier);

  if (!issue) {
    // Try by ID
    try {
      const fetched = await client.issue(identifier);
      if (fetched) {
        const attachments = await fetched.attachments();
        return displayAttachments(fetched.identifier, attachments.nodes, options.json);
      }
    } catch {
      // fall through
    }
    console.error(chalk.red(`Issue not found: ${identifier}`));
    process.exit(1);
  }

  const attachments = await issue.attachments();
  displayAttachments(issue.identifier, attachments.nodes, options.json);
}

function displayAttachments(issueIdentifier: string, attachments: Array<{ id: string; title: string; subtitle?: string; url: string; sourceType?: string; metadata: Record<string, unknown>; source?: Record<string, unknown> | null; createdAt: Date }>, json?: boolean): void {
  const data = attachments.map(a => ({
    id: a.id,
    title: a.title,
    subtitle: a.subtitle,
    url: a.url,
    sourceType: a.sourceType,
    metadata: a.metadata,
    source: a.source,
    createdAt: a.createdAt
  }));

  if (json) {
    output(data, true);
  } else {
    if (data.length === 0) {
      console.log(chalk.yellow(`No attachments found for ${issueIdentifier}`));
      return;
    }
    console.log(chalk.bold(`\nAttachments for ${issueIdentifier} (${data.length}):\n`));
    for (const a of data) {
      console.log(chalk.cyan(`  ${a.title}`));
      if (a.subtitle) console.log(`    ${a.subtitle}`);
      console.log(`    URL: ${a.url}`);
      if (a.sourceType) console.log(`    Source: ${a.sourceType}`);
      console.log(`    Created: ${formatDate(a.createdAt)}`);
      console.log();
    }
  }
}

async function createAttachment(issueIdentifier: string, options: {
  title: string;
  url: string;
  subtitle?: string;
  iconUrl?: string;
  metadata?: string;
  json?: boolean;
}): Promise<void> {
  const client = getClient();
  const issue = await findIssueByIdentifier(client, issueIdentifier);

  if (!issue) {
    console.error(chalk.red(`Issue not found: ${issueIdentifier}`));
    process.exit(1);
  }

  const input: Record<string, unknown> = {
    issueId: issue.id,
    title: options.title,
    url: options.url,
  };
  if (options.subtitle) input.subtitle = options.subtitle;
  if (options.iconUrl) input.iconUrl = options.iconUrl;
  if (options.metadata) input.metadata = JSON.parse(options.metadata);

  const result = await client.createAttachment(input as Parameters<typeof client.createAttachment>[0]);
  const attachment = await result.attachment;

  if (!attachment) {
    console.error(chalk.red('Failed to create attachment'));
    process.exit(1);
  }

  const data = {
    id: attachment.id,
    title: attachment.title,
    subtitle: attachment.subtitle,
    url: attachment.url,
    createdAt: attachment.createdAt,
  };

  if (options.json) {
    output(data, true);
  } else {
    console.log(chalk.green(`\n✓ Created attachment on ${issue.identifier}`));
    console.log(`  Title: ${data.title}`);
    if (data.subtitle) console.log(`  Subtitle: ${data.subtitle}`);
    console.log(`  URL: ${data.url}`);
  }
}

async function updateAttachment(attachmentId: string, options: {
  title: string;
  subtitle?: string;
  iconUrl?: string;
  metadata?: string;
  json?: boolean;
}): Promise<void> {
  const client = getClient();

  const input: Record<string, unknown> = {
    title: options.title,
  };
  if (options.subtitle) input.subtitle = options.subtitle;
  if (options.iconUrl) input.iconUrl = options.iconUrl;
  if (options.metadata) input.metadata = JSON.parse(options.metadata);

  const result = await client.updateAttachment(attachmentId, input as Parameters<typeof client.updateAttachment>[1]);
  const attachment = await result.attachment;

  if (!attachment) {
    console.error(chalk.red('Failed to update attachment'));
    process.exit(1);
  }

  const data = {
    id: attachment.id,
    title: attachment.title,
    subtitle: attachment.subtitle,
    url: attachment.url,
  };

  if (options.json) {
    output(data, true);
  } else {
    console.log(chalk.green(`\n✓ Updated attachment ${attachmentId}`));
    console.log(`  Title: ${data.title}`);
    if (data.subtitle) console.log(`  Subtitle: ${data.subtitle}`);
    console.log(`  URL: ${data.url}`);
  }
}

async function deleteAttachment(attachmentId: string, options: { json?: boolean }): Promise<void> {
  const client = getClient();
  await client.deleteAttachment(attachmentId);

  if (options.json) {
    output({ success: true, id: attachmentId }, true);
  } else {
    console.log(chalk.green(`\n✓ Deleted attachment ${attachmentId}`));
  }
}

// ============================================================================
// Comment Commands
// ============================================================================

async function findIssueByIdentifier(client: LinearClient, identifier: string): Promise<Issue | undefined> {
  const match = identifier.toUpperCase().match(/^([A-Z]+)-(\d+)$/);
  if (match) {
    const [, teamKey, numStr] = match;
    const issueNumber = parseInt(numStr, 10);
    const issues = await client.issues({
      filter: {
        team: { key: { eq: teamKey } },
        number: { eq: issueNumber }
      }
    });
    return issues.nodes[0];
  }
  return undefined;
}

async function listComments(issueIdentifier: string, options: { json?: boolean }): Promise<void> {
  const client = getClient();

  const issue = await findIssueByIdentifier(client, issueIdentifier);

  if (!issue) {
    console.error(chalk.red(`Issue not found: ${issueIdentifier}`));
    process.exit(1);
  }

  const comments = await issue.comments();

  const data = await Promise.all(comments.nodes.map(async (c) => {
    const user = await c.user;
    return {
      id: c.id,
      body: c.body,
      user: user ? { id: user.id, name: user.name } : null,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt
    };
  }));

  if (options.json) {
    output(data, true);
  } else {
    console.log(chalk.bold(`\nComments on ${issueIdentifier}:\n`));
    data.forEach(c => {
      console.log(`${chalk.cyan(c.user?.name || 'Unknown')} - ${formatDate(c.createdAt)}`);
      console.log(`  ${c.body}`);
      console.log();
    });
  }
}

async function createComment(issueIdentifier: string, body: string, options: { json?: boolean }): Promise<void> {
  const client = getClient();

  const issue = await findIssueByIdentifier(client, issueIdentifier);

  if (!issue) {
    console.error(chalk.red(`Issue not found: ${issueIdentifier}`));
    process.exit(1);
  }

  const result = await client.createComment({
    issueId: issue.id,
    body
  });

  const comment = await result.comment;

  if (options.json) {
    output({ success: true, id: comment?.id }, true);
  } else {
    console.log(chalk.green(`Comment added to ${issueIdentifier}`));
  }
}

// ============================================================================
// Cycle Commands
// ============================================================================

async function listCycles(options: { team: string; json?: boolean }): Promise<void> {
  const client = getClient();

  const teams = await client.teams({ filter: { key: { eq: options.team.toUpperCase() } } });
  const team = teams.nodes[0];

  if (!team) {
    console.error(chalk.red(`Team not found: ${options.team}`));
    process.exit(1);
  }

  const cycles = await team.cycles();

  const data = cycles.nodes.map(c => ({
    id: c.id,
    number: c.number,
    name: c.name,
    startsAt: c.startsAt,
    endsAt: c.endsAt,
    progress: c.progress
  }));

  if (options.json) {
    output(data, true);
  } else {
    console.log(chalk.bold(`\nCycles for ${options.team}:\n`));
    data.forEach(c => {
      console.log(`${chalk.cyan(`Cycle ${c.number}`)} ${c.name || ''}`);
      console.log(`  ${formatDate(c.startsAt)} - ${formatDate(c.endsAt)}`);
      console.log(`  Progress: ${Math.round((c.progress || 0) * 100)}%`);
      console.log();
    });
  }
}

// ============================================================================
// Initiatives/Roadmap Commands
// ============================================================================

async function listInitiatives(options: { json?: boolean }): Promise<void> {
  const client = getClient();
  const initiatives = await client.initiatives();

  const data = initiatives.nodes.map(i => ({
    id: i.id,
    name: i.name,
    description: i.description,
    slugId: i.slugId
  }));

  if (options.json) {
    output(data, true);
  } else {
    console.log(chalk.bold('\nInitiatives:\n'));
    data.forEach(i => {
      console.log(`${chalk.cyan(i.name)}`);
      console.log(`  ID: ${i.id}`);
      if (i.description) {
        console.log(`  ${i.description}`);
      }
      console.log();
    });
  }
}

// ============================================================================
// CLI Setup
// ============================================================================

const program = new Command();

program
  .name('linear-cli')
  .description('Comprehensive CLI for Linear API operations')
  .version('1.0.0');

// Project commands
const projectCmd = program.command('project').description('Project operations');

projectCmd
  .command('list')
  .description('List projects')
  .option('-t, --team <key>', 'Filter by team key')
  .option('-l, --limit <number>', 'Limit results', '50')
  .option('-j, --json', 'Output as JSON')
  .action((opts) => listProjects({ ...opts, limit: parseInt(opts.limit) }));

projectCmd
  .command('get <id>')
  .description('Get project by ID or slug')
  .option('-j, --json', 'Output as JSON')
  .action(getProject);

projectCmd
  .command('from-url <url>')
  .description('Get project from Linear URL')
  .option('-j, --json', 'Output as JSON')
  .action(getProjectFromUrl);

projectCmd
  .command('updates <project>')
  .description('List project updates (accepts ID, slug, or URL)')
  .option('-l, --limit <number>', 'Limit results', '20')
  .option('-j, --json', 'Output as JSON')
  .action((project, opts) => listProjectUpdates(project, { ...opts, limit: parseInt(opts.limit) }));

projectCmd
  .command('update <project>')
  .description('Create a project update (accepts ID, slug, or URL)')
  .requiredOption('-b, --body <text>', 'Update body/content (markdown supported)')
  .addOption(
    new Option('-h, --health <status>', 'Project health status')
      .choices(Object.values(ProjectUpdateHealthType))
  )
  .option('-a, --attachments <items...>', 'Attachments as "Title|URL" pairs, appended to body')
  .option('-j, --json', 'Output as JSON')
  .action((project, opts) => createProjectUpdate(project, opts));

projectCmd
  .command('edit <project>')
  .description('Edit project properties (accepts ID, slug, or URL)')
  .option('--name <name>', 'New project name')
  .option('--description <text>', 'Short summary shown under project title')
  .option('--content <text>', 'Full project description in markdown (the "Description" section)')
  .option('--lead <id>', 'Project lead (user ID, "me", or "none")')
  .option('--priority <number>', 'Priority (0=None, 1=Urgent, 2=High, 3=Normal, 4=Low)')
  .option('--start-date <date>', 'Start date (YYYY-MM-DD)')
  .option('--target-date <date>', 'Target date (YYYY-MM-DD)')
  .option('--color <color>', 'Project color')
  .option('--icon <icon>', 'Project icon')
  .option('-j, --json', 'Output as JSON')
  .action((project, opts) => editProject(project, { ...opts, priority: opts.priority !== undefined ? parseInt(opts.priority) : undefined }));

// Issue commands
const issueCmd = program.command('issue').description('Issue operations');

issueCmd
  .command('list')
  .description('List issues')
  .option('-p, --project <id>', 'Filter by project ID')
  .option('-t, --team <key>', 'Filter by team key')
  .option('-a, --assignee <id>', 'Filter by assignee (use "me" for yourself)')
  .option('-s, --state <name>', 'Filter by state name')
  .option('--status <name>', 'Alias for --state')
  .option('-l, --limit <number>', 'Limit results', '50')
  .option('-j, --json', 'Output as JSON')
  .action((opts) => listIssues({ ...opts, state: opts.state || opts.status, limit: parseInt(opts.limit) }));

issueCmd
  .command('get <identifier>')
  .description('Get issue by identifier (e.g., KAR-123)')
  .option('-j, --json', 'Output as JSON')
  .option('-f, --full', 'Include comments and full details')
  .action(getIssue);

issueCmd
  .command('create')
  .description('Create a new issue')
  .requiredOption('--title <title>', 'Issue title')
  .requiredOption('--team <key>', 'Team key')
  .option('--description <desc>', 'Issue description')
  .option('--project <id>', 'Project ID')
  .option('--assignee <id>', 'Assignee ID (use "me" for yourself)')
  .option('--priority <number>', 'Priority (1=urgent, 4=low)', (v: string) => parseInt(v, 10))
  .option('--estimate <number>', 'Estimate (story points)', (v: string) => parseInt(v, 10))
  .option('--labels <ids...>', 'Label IDs')
  .option('--parent <id>', 'Parent issue ID')
  .option('-j, --json', 'Output as JSON')
  .action(createIssue);

issueCmd
  .command('update <identifier>')
  .description('Update an issue')
  .option('--title <title>', 'New title')
  .option('--description <desc>', 'New description')
  .option('--state <name>', 'New state name')
  .option('--status <name>', 'Alias for --state')
  .option('--assignee <id>', 'New assignee (use "me" or "none")')
  .option('--priority <number>', 'New priority', (v: string) => parseInt(v, 10))
  .option('--estimate <number>', 'New estimate (story points)', (v: string) => parseInt(v, 10))
  .option('--project <id>', 'Project ID')
  .option('-j, --json', 'Output as JSON')
  .action((identifier: string, opts: Record<string, unknown>) =>
    updateIssue(identifier, { ...opts, state: opts.state || opts.status } as Parameters<typeof updateIssue>[1])
  );

issueCmd
  .command('attachments <identifier>')
  .description('List attachments/resources for an issue (e.g., KAR-123)')
  .option('-j, --json', 'Output as JSON')
  .action(getAttachments);

// Team commands
const teamCmd = program.command('team').description('Team operations');

teamCmd
  .command('list')
  .description('List teams')
  .option('-j, --json', 'Output as JSON')
  .action(listTeams);

teamCmd
  .command('get <key>')
  .description('Get team by key or ID')
  .option('-j, --json', 'Output as JSON')
  .action(getTeam);

// User commands
const userCmd = program.command('user').description('User operations');

userCmd
  .command('list')
  .description('List users')
  .option('-t, --team <key>', 'Filter by team')
  .option('-j, --json', 'Output as JSON')
  .action(listUsers);

userCmd
  .command('me')
  .description('Get current user')
  .option('-j, --json', 'Output as JSON')
  .action(getMe);

// Document commands
const docCmd = program.command('document').description('Document operations');

docCmd
  .command('list')
  .description('List documents')
  .option('-p, --project <id>', 'Filter by project ID')
  .option('-l, --limit <number>', 'Limit results', '50')
  .option('-j, --json', 'Output as JSON')
  .action((opts) => listDocuments({ ...opts, limit: parseInt(opts.limit) }));

docCmd
  .command('get <id>')
  .description('Get document by ID')
  .option('-j, --json', 'Output as JSON')
  .action(getDocument);

docCmd
  .command('create')
  .description('Create a new document')
  .requiredOption('--title <title>', 'Document title')
  .option('--content <content>', 'Document content (markdown)')
  .option('--project <id>', 'Project ID to associate with')
  .option('--icon <icon>', 'Document icon')
  .option('--color <color>', 'Icon color')
  .option('-j, --json', 'Output as JSON')
  .action(createDocument);

docCmd
  .command('update <id>')
  .description('Update a document')
  .option('--title <title>', 'New title')
  .option('--content <content>', 'New content (markdown)')
  .option('--project <id>', 'New project ID')
  .option('--icon <icon>', 'New icon')
  .option('--color <color>', 'New icon color')
  .option('-j, --json', 'Output as JSON')
  .action(updateDocument);

docCmd
  .command('delete <id>')
  .description('Delete (trash) a document')
  .option('-j, --json', 'Output as JSON')
  .action(deleteDocument);

// Label commands
const labelCmd = program.command('label').description('Label operations');

labelCmd
  .command('list')
  .description('List labels')
  .option('-t, --team <key>', 'Filter by team')
  .option('-j, --json', 'Output as JSON')
  .action(listLabels);

// Attachment commands
const attachmentCmd = program.command('attachment').description('Attachment operations');

attachmentCmd
  .command('list <identifier>')
  .description('List attachments for an issue (e.g., KAR-123)')
  .option('-j, --json', 'Output as JSON')
  .action(getAttachments);

attachmentCmd
  .command('create <identifier>')
  .description('Create an attachment on an issue (e.g., KAR-123)')
  .requiredOption('--title <title>', 'Attachment title')
  .requiredOption('--url <url>', 'Attachment URL')
  .option('--subtitle <subtitle>', 'Attachment subtitle')
  .option('--icon-url <iconUrl>', 'Icon URL (jpg/png, 20x20px)')
  .option('--metadata <json>', 'Metadata as JSON string')
  .option('-j, --json', 'Output as JSON')
  .action(createAttachment);

attachmentCmd
  .command('update <id>')
  .description('Update an attachment by ID')
  .requiredOption('--title <title>', 'Attachment title')
  .option('--subtitle <subtitle>', 'Attachment subtitle')
  .option('--icon-url <iconUrl>', 'Icon URL (jpg/png, 20x20px)')
  .option('--metadata <json>', 'Metadata as JSON string')
  .option('-j, --json', 'Output as JSON')
  .action(updateAttachment);

attachmentCmd
  .command('delete <id>')
  .description('Delete an attachment by ID')
  .option('-j, --json', 'Output as JSON')
  .action(deleteAttachment);

// Comment commands
const commentCmd = program.command('comment').description('Comment operations');

commentCmd
  .command('list <issue>')
  .description('List comments on an issue')
  .option('-j, --json', 'Output as JSON')
  .action(listComments);

commentCmd
  .command('create <issue> <body>')
  .description('Create a comment on an issue')
  .option('-j, --json', 'Output as JSON')
  .action(createComment);

// Cycle commands
const cycleCmd = program.command('cycle').description('Cycle operations');

cycleCmd
  .command('list')
  .description('List cycles')
  .requiredOption('-t, --team <key>', 'Team key')
  .option('-j, --json', 'Output as JSON')
  .action(listCycles);

// Initiative commands
const initiativeCmd = program.command('initiative').description('Initiative/Roadmap operations');

initiativeCmd
  .command('list')
  .description('List initiatives')
  .option('-j, --json', 'Output as JSON')
  .action(listInitiatives);

program.parse();
