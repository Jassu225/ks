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

/**
 * Return to the directory the CLI was invoked from. The `linear`, `slack` and
 * `grain` wrappers cd into scripts/ so `npx tsx` resolves, and pass the caller's
 * directory as KS_ORIGINAL_DIR; without this, relative paths (`--content-file
 * doc.md`, `-f shot.png`, `-o out.mp4`) resolved against scripts/ instead.
 */
export function restoreCallerCwd(): void {
  const dir = process.env.KS_ORIGINAL_DIR;
  if (!dir) return;
  try {
    process.chdir(dir);
  } catch {
    // The caller's directory is gone; relative paths fall back to scripts/.
  }
}
