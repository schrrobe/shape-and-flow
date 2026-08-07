import { i18n } from '../../i18n/index.js';

import de from './de.json';
import en from './en.json';

let registered = false;

/**
 * Merge office copy into the app-wide i18n instance, on demand.
 *
 * `src/i18n/index.ts` is imported by every visitor, customer and staff alike, so office
 * strings cannot live in `de.json`/`en.json` without shipping eleven management screens'
 * worth of text to everyone who opens the booking flow. This file sits next to the office
 * area instead, reached only through the same lazy `import()` the router already uses for
 * `/office/*`, and merges itself into the shared i18n instance the first time any office
 * screen mounts.
 */
export function registerOfficeMessages(): void {
  if (registered) return;
  registered = true;

  i18n.global.mergeLocaleMessage('de', { office: de });
  i18n.global.mergeLocaleMessage('en', { office: en });
}
