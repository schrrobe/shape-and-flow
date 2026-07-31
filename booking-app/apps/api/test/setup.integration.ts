import { afterAll } from 'vitest';

import { disconnectDatabase } from './database.harness.js';

// NestJS decorators write to the metadata reflection API, so this import must
// happen before any decorated class is evaluated.
import 'reflect-metadata';

// One pool per test file; close it so Vitest can exit cleanly instead of
// hanging on an open connection.
afterAll(async () => {
  await disconnectDatabase();
});
