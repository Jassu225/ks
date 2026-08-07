import dotenv from 'dotenv';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path to the scripts/ directory */
export const SCRIPTS_DIR = path.resolve(__dirname, '..');

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
