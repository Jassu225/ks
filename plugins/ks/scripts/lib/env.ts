import dotenv from 'dotenv';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Absolute path to the scripts/ directory. Built, this file is dist/lib/env.js,
 * one level deeper, so step out of dist/ too: .env and the shell scripts live
 * beside the sources, not in the build.
 */
const parent = path.resolve(__dirname, '..');
export const SCRIPTS_DIR = path.basename(parent) === 'dist' ? path.dirname(parent) : parent;

/** Absolute path to the plugin root (plugins/ks/) */
export const PLUGIN_DIR = path.resolve(SCRIPTS_DIR, '..');

/**
 * Load environment variables from scripts/.env and plugin .config
 */
export function loadEnv(): void {
  dotenv.config({
    path: [
      path.join(SCRIPTS_DIR, '.env'),
      path.join(PLUGIN_DIR, '.config'),
    ],
    // Without this, dotenv v17 prints an "injecting env" banner to STDOUT,
    // which corrupts every `--json` output when piped into jq.
    quiet: true,
  });
}
