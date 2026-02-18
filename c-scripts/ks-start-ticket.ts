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

import 'dotenv/config';
import { LinearClient, Issue, User } from '@linear/sdk';
import * as yaml from 'yaml';
import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { execSync, spawn } from 'child_process';

// ============================================================================
// Types
// ============================================================================

interface TicketWorkflowState {
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
  phases: Array<{
    number: number;
    name: string;
    status: 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED' | 'SKIPPED';
    started_at: string | null;
    ended_at: string | null;
  }>;
}

// ============================================================================
// Linear Client
// ============================================================================

function getClient(): LinearClient {
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) {
    console.error(chalk.red('Error: LINEAR_API_KEY environment variable is not set'));
    console.error(chalk.yellow('Get your API key from: https://linear.app/settings/api'));
    process.exit(1);
  }
  return new LinearClient({ apiKey });
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

async function fetchIssueData(client: LinearClient, identifier: string): Promise<Issue> {
  console.log(chalk.blue('Fetching issue information...'));

  const issue = await client.issue(identifier);

  if (!issue) {
    throw new Error(`Issue not found: ${identifier}`);
  }

  return issue;
}

// ============================================================================
// Priority Mapping
// ============================================================================

function getPriorityName(priority: number | null | undefined): string {
  const priorityMap: Record<number, string> = {
    0: 'None',
    1: 'Urgent',
    2: 'High',
    3: 'Medium',
    4: 'Low'
  };
  return priority !== null && priority !== undefined ? priorityMap[priority] || 'None' : 'None';
}

// ============================================================================
// Workflow State Generation
// ============================================================================

async function generateTicketWorkflowState(
  issue: Issue,
  viewer: User
): Promise<TicketWorkflowState> {
  const state = await issue.state;
  const project = await issue.project;
  const assignee = await issue.assignee;
  const labels = await issue.labels();

  return {
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
  formattedLines.push(`# yaml-language-server: $schema=${homeDir}/.claude/plugins/ks/c-scripts/ticket-state.schema.json`);
  formattedLines.push('');
  formattedLines.push('# Linear Ticket Information');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Add comments before specific sections
    if (line.startsWith('ticket:')) {
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
// Worktree Creation
// ============================================================================

function createWorktreeAndLaunchClaude(branchName: string): void {
  const scriptDir = path.dirname(new URL(import.meta.url).pathname);
  const createWorktreeScript = path.join(scriptDir, 'create-worktree');

  console.log(chalk.blue('\nCreating git worktree...'));

  try {
    // Run create-worktree and capture output
    const targetDir = process.env.KS_ORIGINAL_DIR || process.cwd();
    const output = execSync(`"${createWorktreeScript}" "${branchName}"`, {
      encoding: 'utf-8',
      stdio: ['inherit', 'pipe', 'inherit'],
      cwd: targetDir
    });

    // Parse the WORKTREE_PATH from output
    const worktreePathMatch = output.match(/WORKTREE_PATH=(.+)/);
    if (!worktreePathMatch) {
      throw new Error('Could not determine worktree path from create-worktree output');
    }

    const worktreePath = worktreePathMatch[1].trim();

    // Launch claude with KS plugin in the worktree
    console.log(chalk.blue('\nLaunching Claude with KS plugin in worktree...'));
    process.chdir(worktreePath);

    const claude = spawn('claude', ['--plugin-dir', `${process.env.HOME}/.claude/plugins/ks`], {
      stdio: 'inherit',
      shell: true
    });

    claude.on('error', (err) => {
      console.error(chalk.red(`Failed to launch claude: ${err.message}`));
      process.exit(1);
    });

    claude.on('close', (code) => {
      process.exit(code || 0);
    });

  } catch (error) {
    if (error instanceof Error && 'status' in error) {
      console.error(chalk.red(`\n✗ Failed to create worktree`));
      process.exit(1);
    }
    throw error;
  }
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
    const client = getClient();
    console.log(chalk.blue('Fetching current user...'));
    const viewer = await client.viewer;
    const username = viewer.displayName || viewer.name;
    console.log(chalk.green(`✓ Logged in as: ${username}`));

    // Default output path: ./workflow/{username}/tickets/{identifier}/state.yaml
    const baseDir = process.env.KS_ORIGINAL_DIR || process.cwd();
    const outputPath = args[1] || path.join(baseDir, 'workflow', username, 'tickets', identifier.toLowerCase(), 'state.yaml');
    console.log(chalk.gray(`Output: ${outputPath}\n`));

    // Fetch issue
    const issue = await fetchIssueData(client, identifier);
    console.log(chalk.green(`✓ Found issue: ${issue.identifier} - ${issue.title}`));

    // Get branch name from Linear (falls back to identifier if not available)
    const branchName = issue.branchName || identifier.toLowerCase();
    console.log(chalk.gray(`Branch name: ${branchName}`));

    // Generate workflow state
    console.log(chalk.blue('\nGenerating workflow state...'));
    const workflowState = await generateTicketWorkflowState(issue, viewer);

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
    createWorktreeAndLaunchClaude(branchName);

  } catch (error) {
    console.error(chalk.red(`\n✗ Error: ${error instanceof Error ? error.message : String(error)}`));
    process.exit(1);
  }
}

main();
