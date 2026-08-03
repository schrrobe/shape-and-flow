import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { ORG_SCOPED_MODELS } from './tenant.extension.js';

/**
 * Prisma 7 no longer exposes `Prisma.dmmf`, so ORG_SCOPED_MODELS is a
 * hand-maintained list. This test is what stops it drifting: it derives the
 * correct set from schema.prisma and fails if the two disagree, naming the
 * models on each side.
 *
 * Failure means a model gained or lost a required organizationId. Either add it
 * to ORG_SCOPED_MODELS, or — if its organizationId is deliberately nullable
 * because the row precedes tenant resolution — add it to the documented
 * exclusions below.
 */

const schema = readFileSync(new URL('../../prisma/schema.prisma', import.meta.url), 'utf8');

/** Models excluded on purpose, with the reason each is safe. */
const DELIBERATE_EXCLUSIONS = {
  // The tenant root has no organizationId of its own.
  Organization: 'tenant root',
  // Written before the tenant is known; addressed by its own unique key.
  IdempotencyKey: 'nullable organizationId, unique client key',
  StripeWebhookEvent: 'nullable organizationId, unique provider event id',
  MessagingWebhookEvent: 'nullable organizationId, unique provider event id',
} as const;

function modelsWithRequiredOrganizationId(): string[] {
  const found: string[] = [];

  for (const match of schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    const name = match[1] ?? '';
    const body = match[2] ?? '';

    const field = body
      .split('\n')
      .map((line) => line.trim())
      .find((line) => /^organizationId\s+String/.test(line));

    // Present and NOT NULL.
    if (field && !/^organizationId\s+String\?/.test(field)) found.push(name);
  }

  return found.sort();
}

describe('ORG_SCOPED_MODELS', () => {
  it('matches every model with a required organizationId in the schema', () => {
    expect([...ORG_SCOPED_MODELS].sort()).toEqual(modelsWithRequiredOrganizationId());
  });

  it('is not empty, so a broken parse cannot make this vacuously pass', () => {
    expect(ORG_SCOPED_MODELS.length).toBeGreaterThan(20);
  });

  it('excludes exactly the four documented models', () => {
    const allModels = [...schema.matchAll(/^model\s+(\w+)\s*\{/gm)].map((match) => match[1] ?? '');
    const excluded = allModels.filter((model) => !ORG_SCOPED_MODELS.includes(model as never));

    expect(excluded.sort()).toEqual(Object.keys(DELIBERATE_EXCLUSIONS).sort());
  });

  it('covers every model that stores customer or money data', () => {
    for (const model of [
      'Booking',
      'Customer',
      'Payment',
      'ManualPayment',
      'Refund',
      'Notification',
      'AuditLog',
    ]) {
      expect(ORG_SCOPED_MODELS, `${model} must be tenant-guarded`).toContain(model);
    }
  });
});
