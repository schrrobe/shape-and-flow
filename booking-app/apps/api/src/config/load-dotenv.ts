import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { config as loadDotenvFile } from 'dotenv';

/**
 * Load `booking-app/.env` into the ambient environment, if it exists.
 *
 * Called from the process entrypoints only. Real environment variables always
 * win — dotenv never overwrites what is already set — so a container that
 * supplies its configuration directly is unaffected, and in that case no file
 * is found and this is a no-op.
 *
 * @returns the path that was loaded, or null when running on ambient env only.
 */
export function loadEnvFile(): string | null {
  const candidates = [
    // `pnpm api dev` runs with the api package as cwd.
    resolve(process.cwd(), '../../.env'),
    // Running a command from booking-app/ directly.
    resolve(process.cwd(), '.env'),
  ];

  for (const path of candidates) {
    if (existsSync(path)) {
      loadDotenvFile({ path, quiet: true });
      return path;
    }
  }

  return null;
}
