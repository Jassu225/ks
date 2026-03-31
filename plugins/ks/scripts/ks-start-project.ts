#!/usr/bin/env npx tsx
/**
 * KS Start Project - Initialize a KarmaSuite workflow from a Linear project
 *
 * This script:
 * 1. Takes a Linear project URL
 * 2. Fetches project information and issues
 * 3. Prompts user to select PRD, TAD, prototype, and implementation plan tickets
 * 4. Generates a workflow state YAML file
 *
 * Usage: npx tsx ks-start-project.ts <project-url> [output-path]
 *
 * Environment: LINEAR_API_KEY must be set (loaded from .env file)
 */

import { Project, Issue, User } from '@linear/sdk';
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

interface TicketSelection {
  prd_ticket_id: string | null;
  prototype_ticket_id: string | null;
  tad_ticket_id: string | null;
  implementation_plan_ticket_id: string | null;
}

interface WorkflowState {
  worktree_dir: string | null;
  project: {
    id: string;
    name: string;
    url: string;
    summary: string | null;
    dates: {
      created_at: string;
      updated_at: string;
      start_date: string | null;
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
    initiatives: Array<{ id: string; name: string }>;
    lead: {
      id: string;
      name: string;
    } | null;
    whoami: {
      id: string;
      name: string;
      username: string;
      email: string;
    } | null;
    prd_ticket_id: string | null;
    prototype_ticket_id: string | null;
    tad_ticket_id: string | null;
    implementation_plan_ticket_id: string | null;
  };
  slack: {
    project_thread: SlackThread | null;
    pr_review_threads: PrReviewThread[];
    release_thread: SlackThread | null;
  };
  phases: Phase[];
}

interface IssueChoice {
  id: string;
  identifier: string;
  title: string;
  state: string;
  display: string;
}

// ============================================================================
// URL Parsing
// ============================================================================

interface ParsedProjectUrl {
  id: string;
  slug: string;
}

function parseProjectUrl(url: string): ParsedProjectUrl {
  // Parse Linear project URL: https://linear.app/{workspace}/project/{slug}
  // Example: https://linear.app/karmasuite/project/basic-egl-optimisation-17b7b66ef9df
  // slug = basic-egl-optimisation-17b7b66ef9df (used for directory name)
  // id = 17b7b66ef9df (UUID part, used for Linear API lookup)
  const match = url.match(/linear\.app\/[^\/]+\/project\/([^\/\?]+)/);
  if (!match) {
    throw new Error('Invalid Linear project URL. Expected format: https://linear.app/{workspace}/project/{slug}');
  }

  const slug = match[1];
  // Extract the UUID part for API lookup (Linear SDK can handle both slug and UUID)
  const idMatch = slug.match(/([a-f0-9]{8,}[a-f0-9-]*)$/i);

  return {
    id: idMatch ? idMatch[1] : slug,
    slug: slug
  };
}

// ============================================================================
// Data Fetching
// ============================================================================

async function fetchProjectData(projectIdOrSlug: string): Promise<Project> {
  console.log(chalk.blue('Fetching project information...'));

  const client = getLinearClient();
  let project: Project | undefined;

  // First try direct ID lookup
  try {
    project = await client.project(projectIdOrSlug);
  } catch {
    // Try searching by slugId
    const projects = await client.projects({
      filter: { slugId: { contains: projectIdOrSlug } }
    });

    if (projects.nodes.length > 0) {
      project = projects.nodes[0];
    }
  }

  if (!project) {
    throw new Error(`Project not found: ${projectIdOrSlug}`);
  }

  return project;
}

async function fetchProjectIssues(projectId: string): Promise<Issue[]> {
  console.log(chalk.blue('Fetching project issues...'));

  const client = getLinearClient();
  const issues = await client.issues({
    filter: { project: { id: { eq: projectId } } },
    first: 100
  });

  return issues.nodes;
}

// ============================================================================
// Slack URL Parsing
// ============================================================================

async function promptForProjectThread(): Promise<SlackThread | null> {
  const { slackUrl } = await inquirer.prompt([{
    type: 'input',
    name: 'slackUrl',
    message: chalk.cyan('Paste Slack message URL for project thread (Enter to skip):'),
  }]);

  if (!slackUrl || slackUrl.trim() === '') return null;
  return parseSlackMessageUrl(slackUrl.trim());
}

// ============================================================================
// User Prompts
// ============================================================================

async function selectTickets(issues: Issue[]): Promise<TicketSelection> {
  // Prepare issue choices
  const choices: IssueChoice[] = await Promise.all(
    issues.map(async (issue) => {
      const state = await issue.state;
      return {
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        state: state?.name || 'Unknown',
        display: `${issue.identifier}: ${issue.title} [${state?.name || 'Unknown'}]`
      };
    })
  );

  // Sort by identifier for easier navigation
  choices.sort((a, b) => a.identifier.localeCompare(b.identifier));

  const noneOption = { id: 'none', identifier: 'NONE', title: 'Skip this selection', state: '', display: '-- None / Skip --' };

  console.log(chalk.bold('\n📋 Select the key tickets for this project:\n'));

  // Helper function to find likely matches
  const findLikelyMatches = (keyword: string): IssueChoice[] => {
    const lower = keyword.toLowerCase();
    return choices.filter(c =>
      c.title.toLowerCase().includes(lower) ||
      c.identifier.toLowerCase().includes(lower)
    );
  };

  // PRD Selection
  const prdMatches = findLikelyMatches('prd');
  const prdChoices = prdMatches.length > 0
    ? [...prdMatches, noneOption, ...choices.filter(c => !prdMatches.includes(c))]
    : [noneOption, ...choices];

  const prdAnswer = await inquirer.prompt([{
    type: 'list',
    name: 'ticket',
    message: chalk.cyan('Select PRD (Product Requirements Document) ticket:'),
    choices: prdChoices.map(c => ({ name: c.display, value: c.identifier })),
    pageSize: 15
  }]);

  // Prototype Selection
  const protoMatches = findLikelyMatches('prototype');
  const protoChoices = protoMatches.length > 0
    ? [...protoMatches, noneOption, ...choices.filter(c => !protoMatches.includes(c))]
    : [noneOption, ...choices];

  const protoAnswer = await inquirer.prompt([{
    type: 'list',
    name: 'ticket',
    message: chalk.cyan('Select Prototype ticket:'),
    choices: protoChoices.map(c => ({ name: c.display, value: c.identifier })),
    pageSize: 15
  }]);

  // TAD Selection
  const tadMatches = [...findLikelyMatches('tad'), ...findLikelyMatches('technical architecture')];
  const uniqueTadMatches = Array.from(new Set(tadMatches.map(t => t.identifier))).map(id => tadMatches.find(t => t.identifier === id)!).filter(Boolean);
  const tadChoices = uniqueTadMatches.length > 0
    ? [...uniqueTadMatches, noneOption, ...choices.filter(c => !uniqueTadMatches.includes(c))]
    : [noneOption, ...choices];

  const tadAnswer = await inquirer.prompt([{
    type: 'list',
    name: 'ticket',
    message: chalk.cyan('Select TAD (Technical Architecture Document) ticket:'),
    choices: tadChoices.map(c => ({ name: c.display, value: c.identifier })),
    pageSize: 15
  }]);

  // Implementation Plan Selection
  const implMatches = [...findLikelyMatches('implementation'), ...findLikelyMatches('plan')];
  const uniqueImplMatches = Array.from(new Set(implMatches.map(t => t.identifier))).map(id => implMatches.find(t => t.identifier === id)!).filter(Boolean);
  const implChoices = uniqueImplMatches.length > 0
    ? [...uniqueImplMatches, noneOption, ...choices.filter(c => !uniqueImplMatches.includes(c))]
    : [noneOption, ...choices];

  const implAnswer = await inquirer.prompt([{
    type: 'list',
    name: 'ticket',
    message: chalk.cyan('Select Implementation Plan ticket:'),
    choices: implChoices.map(c => ({ name: c.display, value: c.identifier })),
    pageSize: 15
  }]);

  return {
    prd_ticket_id: prdAnswer.ticket === 'NONE' ? null : prdAnswer.ticket,
    prototype_ticket_id: protoAnswer.ticket === 'NONE' ? null : protoAnswer.ticket,
    tad_ticket_id: tadAnswer.ticket === 'NONE' ? null : tadAnswer.ticket,
    implementation_plan_ticket_id: implAnswer.ticket === 'NONE' ? null : implAnswer.ticket
  };
}

// ============================================================================
// YAML Generation
// ============================================================================

async function generateWorkflowState(
  project: Project,
  viewer: User,
  ticketSelection: TicketSelection,
  projectThread: SlackThread | null
): Promise<WorkflowState> {
  const lead = await project.lead;
  const status = await project.status;
  const initiatives = await project.initiatives();

  return {
    worktree_dir: null,
    project: {
      id: project.id,
      name: project.name,
      url: project.url,
      summary: project.description || null,
      dates: {
        created_at: project.createdAt.toISOString(),
        updated_at: project.updatedAt.toISOString(),
        start_date: project.startDate || null
      },
      priority: {
        value: project.priority ?? null,
        name: getPriorityName(project.priority)
      },
      status: status ? {
        id: status.id,
        name: status.name
      } : null,
      labels: [], // Linear projects don't have labels in the same way as issues
      initiatives: initiatives.nodes.map(i => ({ id: i.id, name: i.name })),
      lead: lead ? {
        id: lead.id,
        name: lead.name
      } : null,
      whoami: {
        id: viewer.id,
        name: viewer.name,
        username: viewer.displayName || viewer.name,
        email: viewer.email || ''
      },
      prd_ticket_id: ticketSelection.prd_ticket_id,
      prototype_ticket_id: ticketSelection.prototype_ticket_id,
      tad_ticket_id: ticketSelection.tad_ticket_id,
      implementation_plan_ticket_id: ticketSelection.implementation_plan_ticket_id
    },
    slack: {
      project_thread: projectThread,
      pr_review_threads: [],
      release_thread: null
    },
    phases: [
      {
        number: 0,
        name: 'project-initialization',
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

function formatYaml(state: WorkflowState): string {
  // Create YAML with comments
  const yamlContent = yaml.stringify(state, {
    lineWidth: 0,
    defaultKeyType: 'PLAIN',
    defaultStringType: 'QUOTE_DOUBLE'
  });

  // Add section comments
  const lines = yamlContent.split('\n');
  const formattedLines: string[] = [];

  // Add schema reference for editor validation (using $HOME for portability)
  const homeDir = process.env.HOME || '~';
  formattedLines.push(`# yaml-language-server: $schema=${homeDir}/.claude/plugins/ks/scripts/project-state.schema.json`);
  formattedLines.push('');
  formattedLines.push('# Linear Project Information');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Add comments before specific sections
    if (line.startsWith('worktree_dir:')) {
      formattedLines.push('# Git worktree directory (updated after worktree creation)');
      formattedLines.push(line);
    } else if (line.startsWith('project:')) {
      formattedLines.push(line);
    } else if (line.match(/^\s{2}summary:/)) {
      formattedLines.push('');
      formattedLines.push('  # Project details');
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
    } else if (line.match(/^\s{2}initiatives:/)) {
      formattedLines.push('');
      formattedLines.push('  # Initiatives');
      formattedLines.push(line);
    } else if (line.match(/^\s{2}lead:/)) {
      formattedLines.push('');
      formattedLines.push('  # Project lead');
      formattedLines.push(line);
    } else if (line.match(/^\s{2}whoami:/)) {
      formattedLines.push('');
      formattedLines.push('  # API key owner (who created this state)');
      formattedLines.push(line);
    } else if (line.match(/^\s{2}prd_ticket_id:/)) {
      formattedLines.push('');
      formattedLines.push('  # Important tickets of the Project');
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
${chalk.bold('KS Start Project')} - Initialize a KarmaSuite workflow from a Linear project

${chalk.cyan('Usage:')}
  npx tsx ks-start-project.ts <project-url> [output-path]

${chalk.cyan('Arguments:')}
  project-url    Linear project URL (e.g., https://linear.app/karmasuite/project/my-feature-abc123)
  output-path    Optional output file path (default: ./workflow/{username}/{project-slug}/state.yaml)

${chalk.cyan('Environment:')}
  LINEAR_API_KEY  Required. Get from https://linear.app/settings/api

${chalk.cyan('What it does:')}
  1. Fetches project info and issues from Linear
  2. Prompts you to select PRD, Prototype, TAD, and Implementation Plan tickets
  3. Generates a workflow state YAML file
  4. Creates a git worktree for the project
  5. Launches Claude-KS in the worktree

${chalk.cyan('Example:')}
  LINEAR_API_KEY=lin_api_xxx npx tsx ks-start-project.ts https://linear.app/karmasuite/project/my-feature-abc123
`);
    process.exit(0);
  }

  const projectUrl = args[0];

  try {
    // Parse URL
    console.log(chalk.bold('\n🚀 KS Start Project\n'));
    console.log(chalk.gray(`Project URL: ${projectUrl}`));

    const { id: projectId, slug: projectSlug } = parseProjectUrl(projectUrl);

    // Initialize client and fetch current user
    const client = getLinearClient();
    console.log(chalk.blue('Fetching current user...'));
    const viewer = await client.viewer;
    const username = viewer.displayName || viewer.name;
    console.log(chalk.green(`✓ Logged in as: ${username}`));

    // Default output path: ./workflow/{username}/{project-slug}/state.yaml
    // Use KS_ORIGINAL_DIR if set (from bash wrapper), otherwise use cwd
    const baseDir = process.env.KS_ORIGINAL_DIR || process.cwd();
    const outputPath = args[1] || path.join(baseDir, 'workflow', username, projectSlug, 'state.yaml');
    console.log(chalk.gray(`Output: ${outputPath}\n`));

    // Fetch project
    const project = await fetchProjectData(projectId);
    console.log(chalk.green(`✓ Found project: ${project.name}`));

    // Fetch issues
    const issues = await fetchProjectIssues(project.id);
    console.log(chalk.green(`✓ Found ${issues.length} issues`));

    if (issues.length === 0) {
      console.log(chalk.yellow('\n⚠ No issues found in this project. Creating workflow state without ticket selections.'));
    }

    // Select tickets
    const ticketSelection = issues.length > 0
      ? await selectTickets(issues)
      : { prd_ticket_id: null, prototype_ticket_id: null, tad_ticket_id: null, implementation_plan_ticket_id: null };

    // Prompt for Slack project thread
    const projectThread = await promptForProjectThread();

    // Generate workflow state
    console.log(chalk.blue('\nGenerating workflow state...'));
    const workflowState = await generateWorkflowState(project, viewer, ticketSelection, projectThread);

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
    console.log(`  Project: ${workflowState.project.name}`);
    console.log(`  Status: ${workflowState.project.status?.name || 'Unknown'}`);
    console.log(`  Lead: ${workflowState.project.lead?.name || 'Unassigned'}`);
    console.log(`  PRD: ${ticketSelection.prd_ticket_id || 'Not selected'}`);
    console.log(`  Prototype: ${ticketSelection.prototype_ticket_id || 'Not selected'}`);
    console.log(`  TAD: ${ticketSelection.tad_ticket_id || 'Not selected'}`);
    console.log(`  Impl Plan: ${ticketSelection.implementation_plan_ticket_id || 'Not selected'}`);
    console.log(`  Phases: ${workflowState.phases.length} defined`);

    // Show workflow folder relative path before launching
    const workflowRelPath = path.relative(baseDir, path.dirname(outputPath));
    console.log(chalk.cyan(`\n  Workflow: ./${workflowRelPath}/`));

    // Create worktree and launch Claude-KS
    createWorktreeAndLaunchClaude(projectSlug, workflowRelPath, outputPath);

  } catch (error) {
    console.error(chalk.red(`\n✗ Error: ${error instanceof Error ? error.message : String(error)}`));
    process.exit(1);
  }
}

main();
