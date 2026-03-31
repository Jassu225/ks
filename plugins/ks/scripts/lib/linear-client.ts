import { LinearClient } from '@linear/sdk';
import chalk from 'chalk';

/**
 * Create a LinearClient instance using LINEAR_API_KEY from environment.
 * Exits the process if the key is not set.
 */
export function getLinearClient(): LinearClient {
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) {
    console.error(chalk.red('Error: LINEAR_API_KEY environment variable is not set'));
    console.error(chalk.yellow('Get your API key from: https://linear.app/settings/api'));
    process.exit(1);
  }
  return new LinearClient({ apiKey });
}

/**
 * Map Linear numeric priority to human-readable name.
 */
export function getPriorityName(priority: number | null | undefined): string {
  const priorityMap: Record<number, string> = {
    0: 'None',
    1: 'Urgent',
    2: 'High',
    3: 'Medium',
    4: 'Low',
  };
  return priority !== null && priority !== undefined ? priorityMap[priority] || 'None' : 'None';
}
