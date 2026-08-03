import { PassThrough, Readable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { sendCsv } from './exports.controller.js';

import type { Response } from 'express';

describe('sendCsv', () => {
  it('destroys the source when the response is aborted', async () => {
    const source = new Readable({ read: () => undefined });
    const destination = new PassThrough() as PassThrough & {
      setHeader: (name: string, value: string) => void;
    };
    destination.setHeader = vi.fn();
    destination.on('error', () => undefined);
    source.on('error', () => undefined);

    sendCsv(destination as unknown as Response, 'export.csv', () => source);
    const closed = new Promise<void>((resolve) => source.once('close', resolve));
    destination.destroy(new Error('client aborted'));

    await closed;
    expect(source.destroyed).toBe(true);
  });
});
