#!/usr/bin/env npx tsx
/**
 * KS Start Ticket - Initialize a KarmaSuite workflow from a single Linear ticket
 *
 * This script:
 * 1. Takes a Linear issue URL
 * 2. Fetches issue information
 * 3. Generates a workflow state YAML file for a single ticket task
 *
 * Usage: npx tsx ks-start-ticket.ts <issue-url> [output-path]
 *
 * Environment: LINEAR_API_KEY must be set (loaded from .env file)
 */

import { Issue, User } from '@linear/sdk';
import inquirer from 'inquirer';
import * as yaml from 'yaml';
import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';

import { loadEnv } from './lib/env.js';
import { getLinearClient, getPriorityName } from './lib/linear-client.js';
import type { SlackThread, Phase, PrReviewThread } from './lib/workflow-types.js';
import { parseSlackMessageUrl } from './lib/slack.js';
import { createWorktreeAndLaunchClaude } from './lib/worktree.js';

loadEnv();

// ============================================================================
// Types
// ============================================================================

interface TicketWorkflowState {
  worktree_dir: string | null;
  ticket: {
    id: string;
    identifier: string;
    name: string;
    url: string;
    summary: string | null;
    dates: {
      created_at: string;
      updated_at: string;
      due_date: string | null;
    };
    priority: {
      value: number | null;
      name: string;
    };
    status: {
      id: string;
      name: string;
    } | null;
    labels: Array<{ id: string; name: string }>;
    assignee: {
      id: string;
      name: string;
    } | null;
    whoami: {
      id: string;
      name: string;
      username: string;
      email: string;
    } | null;
    estimate: number | null;
    parent_project: {
      id: string;
      name: string;
      url: string;
    } | null;
  };
  slack: {
    project_thread: SlackThread | null;
    pr_review_threads: PrReviewThread[];
    release_thread: SlackThread | null;
  };
  phases: Phase[];
}

// ============================================================================
// URL Parsing
// ============================================================================

interface ParsedIssueUrl {
  identifier: string;
  slug: string;
}

function parseIssueUrl(url: string): ParsedIssueUrl {
  // Parse Linear issue URL: https://linear.app/{workspace}/issue/{identifier}/{slug}
  // Example: https://linear.app/karmasuite/issue/KAR-123/fix-bug-in-login
  // identifier = KAR-123 (used for Linear API lookup)
  // slug = fix-bug-in-login (used for directory name)
  const match = url.match(/linear\.app\/[^\/]+\/issue\/([A-Z]+-\d+)(?:\/([^\/\?]+))?/);
  if (!match) {
    throw new Error('Invalid Linear issue URL. Expected format: https://linear.app/{workspace}/issue/{identifier}/{slug}');
  }

  const identifier = match[1];
  const slug = match[2] || identifier.toLowerCase();

  return {
    identifier,
    slug
  };
}

// ============================================================================
// Data Fetching
// ============================================================================

async function fetchIssueData(identifier: string): Promise<Issue> {
  console.log(chalk.blue('Fetching issue information...'));

  const client = getLinearClient();
  const issue = await client.issue(identifier);

  if (!issue) {
    throw new Error(`Issue not found: ${identifier}`);
  }

  return issue;
}

// ============================================================================
// Slack Thread Resolution
// ============================================================================

async function extractSlackThreadFromIssue(issue: Issue): Promise<SlackThread | null> {
  try {
    const attachments = await issue.attachments();
    for (const attachment of attachments.nodes) {
      // Slack attachments have a URL pointing to a Slack message
      if (attachment.url && /slack\.com\/archives\//.test(attachment.url)) {
        const thread = await parseSlackMessageUrl(attachment.url);
        return thread;
      }
    }
  } catch {
    // Attachments fetch failed -- fall through to manual prompt
  }
  return null;
}

async function getProjectThread(issue: Issue): Promise<SlackThread | null> {
  // First, try to extract from the ticket's attachments
  console.log(chalk.blue('Checking ticket for Slack thread attachment...'));
  const thread = await extractSlackThreadFromIssue(issue);
  if (thread) {
    console.log(chalk.green(`✓ Found Slack thread from ticket attachment: ${thread.url}`));
    return thread;
  }

  // Not found -- ask the user
  console.log(chalk.gray('  No Slack thread found in ticket attachments.'));
  const { slackUrl } = await inquirer.prompt([{
    type: 'input',
    name: 'slackUrl',
    message: chalk.cyan('Paste Slack message URL for project thread (Enter to skip):'),
  }]);

  if (!slackUrl || slackUrl.trim() === '') return null;
  return parseSlackMessageUrl(slackUrl.trim());
}

// ============================================================================
// Workflow State Generation
// ============================================================================

async function generateTicketWorkflowState(
  issue: Issue,
  viewer: User,
  projectThread: SlackThread | null
): Promise<TicketWorkflowState> {
  const state = await issue.state;
  const project = await issue.project;
  const assignee = await issue.assignee;
  const labels = await issue.labels();

  return {
    worktree_dir: null,
    ticket: {
      id: issue.id,
      identifier: issue.identifier,
      name: issue.title,
      url: issue.url,
      summary: issue.description || null,
      dates: {
        created_at: issue.createdAt.toISOString(),
        updated_at: issue.updatedAt.toISOString(),
        due_date: issue.dueDate || null
      },
      priority: {
        value: issue.priority ?? null,
        name: getPriorityName(issue.priority)
      },
      status: state ? {
        id: state.id,
        name: state.name
      } : null,
      labels: labels.nodes.map(l => ({ id: l.id, name: l.name })),
      assignee: assignee ? {
        id: assignee.id,
        name: assignee.name
      } : null,
      whoami: {
        id: viewer.id,
        name: viewer.name,
        username: viewer.displayName || viewer.name,
        email: viewer.email || ''
      },
      estimate: issue.estimate ?? null,
      parent_project: project ? {
        id: project.id,
        name: project.name,
        url: project.url
      } : null
    },
    slack: {
      project_thread: projectThread,
      pr_review_threads: [],
      release_thread: null
    },
    phases: [
      {
        number: 0,
        name: 'ticket-initialization',
        status: 'COMPLETED',
        started_at: new Date().toISOString(),
        ended_at: new Date().toISOString()
      }
    ]
  };
}

// ============================================================================
// YAML Formatting
// ============================================================================

function formatYaml(state: TicketWorkflowState): string {
  // Create YAML with comments
  const yamlContent = yaml.stringify(state, {
    lineWidth: 0,
    defaultKeyType: 'PLAIN',
    defaultStringType: 'QUOTE_DOUBLE'
  });

  // Add section comments
  const lines = yamlContent.split('\n');
  const formattedLines: string[] = [];

  // Add schema reference for editor validation
  const homeDir = process.env.HOME || '~';
  formattedLines.push(`# yaml-language-server: $schema=${homeDir}/.claude/plugins/ks/scripts/ticket-state.schema.json`);
  formattedLines.push('');
  formattedLines.push('# Linear Ticket Information');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Add comments before specific sections
    if (line.startsWith('worktree_dir:')) {
      formattedLines.push('# Git worktree directory (updated after worktree creation)');
      formattedLines.push(line);
    } else if (line.startsWith('ticket:')) {
      formattedLines.push(line);
    } else if (line.match(/^\s{2}summary:/)) {
      formattedLines.push('');
      formattedLines.push('  # Ticket details');
      formattedLines.push(line);
    } else if (line.match(/^\s{2}dates:/)) {
      formattedLines.push('');
      formattedLines.push('  # Timeline');
      formattedLines.push(line);
    } else if (line.match(/^\s{2}priority:/)) {
      formattedLines.push('');
      formattedLines.push('  # Priority');
      formattedLines.push(line);
    } else if (line.match(/^\s{2}status:/)) {
      formattedLines.push('');
      formattedLines.push('  # Status');
      formattedLines.push(line);
    } else if (line.match(/^\s{2}labels:/)) {
      formattedLines.push('');
      formattedLines.push('  # Labels');
      formattedLines.push(line);
    } else if (line.match(/^\s{2}assignee:/)) {
      formattedLines.push('');
      formattedLines.push('  # Assignee');
      formattedLines.push(line);
    } else if (line.match(/^\s{2}whoami:/)) {
      formattedLines.push('');
      formattedLines.push('  # API key owner (who created this state)');
      formattedLines.push(line);
    } else if (line.match(/^\s{2}estimate:/)) {
      formattedLines.push('');
      formattedLines.push('  # Story points estimate');
      formattedLines.push(line);
    } else if (line.match(/^\s{2}parent_project:/)) {
      formattedLines.push('');
      formattedLines.push('  # Parent project (if any)');
      formattedLines.push(line);
    } else if (line.startsWith('slack:')) {
      formattedLines.push('');
      formattedLines.push('# Slack thread references');
      formattedLines.push(line);
    } else if (line.startsWith('phases:')) {
      formattedLines.push('');
      formattedLines.push('# Phases tracking');
      formattedLines.push(line);
    } else {
      formattedLines.push(line);
    }
  }

  return formattedLines.join('\n');
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(`
${chalk.bold('KS Start Ticket')} - Initialize a KarmaSuite workflow from a single Linear ticket

${chalk.cyan('Usage:')}
  npx tsx ks-start-ticket.ts <issue-url> [output-path]

${chalk.cyan('Arguments:')}
  issue-url      Linear issue URL (e.g., https://linear.app/karmasuite/issue/KAR-123/fix-bug)
  output-path    Optional output file path (default: ./workflow/{username}/tickets/{identifier}/state.yaml)

${chalk.cyan('Environment:')}
  LINEAR_API_KEY  Required. Get from https://linear.app/settings/api

${chalk.cyan('What it does:')}
  1. Fetches issue info from Linear
  2. Generates a workflow state YAML file
  3. Creates a git worktree for the ticket
  4. Launches Claude-KS in the worktree

${chalk.cyan('Example:')}
  LINEAR_API_KEY=lin_api_xxx npx tsx ks-start-ticket.ts https://linear.app/karmasuite/issue/KAR-123/fix-bug
`);
    process.exit(0);
  }

  const issueUrl = args[0];

  try {
    // Parse URL
    console.log(chalk.bold('\n🎫 KS Start Ticket\n'));
    console.log(chalk.gray(`Issue URL: ${issueUrl}`));

    const { identifier, slug } = parseIssueUrl(issueUrl);

    // Initialize client and fetch current user
    const client = getLinearClient();
    console.log(chalk.blue('Fetching current user...'));
    const viewer = await client.viewer;
    const username = viewer.displayName || viewer.name;
    console.log(chalk.green(`✓ Logged in as: ${username}`));

    // Default output path: ./workflow/{username}/tickets/{identifier}/state.yaml
    const baseDir = process.env.KS_ORIGINAL_DIR || process.cwd();
    const outputPath = args[1] || path.join(baseDir, 'workflow', username, 'tickets', identifier.toLowerCase(), 'state.yaml');
    console.log(chalk.gray(`Output: ${outputPath}\n`));

    // Fetch issue
    const issue = await fetchIssueData(identifier);
    console.log(chalk.green(`✓ Found issue: ${issue.identifier} - ${issue.title}`));

    // Get branch name from Linear (falls back to identifier if not available)
    const branchName = issue.branchName || identifier.toLowerCase();
    console.log(chalk.gray(`Branch name: ${branchName}`));

    // Try to get Slack thread from ticket attachments, then prompt if not found
    const projectThread = await getProjectThread(issue);

    // Generate workflow state
    console.log(chalk.blue('\nGenerating workflow state...'));
    const workflowState = await generateTicketWorkflowState(issue, viewer, projectThread);

    // Format and write YAML
    const yamlContent = formatYaml(workflowState);

    // Ensure directory exists
    const dir = path.dirname(outputPath);
    if (dir && dir !== '.') {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(outputPath, yamlContent, 'utf-8');

    console.log(chalk.green(`\n✓ Workflow state saved to: ${outputPath}`));

    // Display summary
    console.log(chalk.bold('\n📋 Summary:\n'));
    console.log(`  Ticket: ${workflowState.ticket.identifier} - ${workflowState.ticket.name}`);
    console.log(`  Status: ${workflowState.ticket.status?.name || 'Unknown'}`);
    console.log(`  Priority: ${workflowState.ticket.priority.name}`);
    console.log(`  Assignee: ${workflowState.ticket.assignee?.name || 'Unassigned'}`);
    console.log(`  Project: ${workflowState.ticket.parent_project?.name || 'No project'}`);
    console.log(`  Estimate: ${workflowState.ticket.estimate ?? 'Not estimated'} points`);

    // Show workflow folder relative path before launching
    const workflowRelPath = path.relative(baseDir, path.dirname(outputPath));
    console.log(chalk.cyan(`\n  Workflow: ./${workflowRelPath}/`));

    // Create worktree and launch Claude-KS
    createWorktreeAndLaunchClaude(branchName, workflowRelPath, outputPath);

  } catch (error) {
    console.error(chalk.red(`\n✗ Error: ${error instanceof Error ? error.message : String(error)}`));
    process.exit(1);
  }
}

main();
