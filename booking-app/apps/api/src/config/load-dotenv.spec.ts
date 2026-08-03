import { beforeEach, describe, expect, it, vi } from 'vitest';

const { existsSync, loadDotenvFile, resolve } = vi.hoisted(() => ({
  existsSync: vi.fn(),
  loadDotenvFile: vi.fn(),
  resolve: vi.fn((...parts: string[]) => parts.join('/')),
}));

vi.mock('node:fs', () => ({ existsSync }));
vi.mock('node:path', () => ({ resolve }));
vi.mock('dotenv', () => ({ config: loadDotenvFile }));

import { loadEnvFile } from './load-dotenv.js';

describe('loadEnvFile', () => {
  beforeEach(() => {
    existsSync.mockReset();
    loadDotenvFile.mockReset();
    resolve.mockClear();
  });

  it('loads the first repository env file found without overriding ambient values', () => {
    existsSync.mockReturnValueOnce(true);

    const loaded = loadEnvFile();

    expect(loaded).toContain('../../.env');
    expect(loadDotenvFile).toHaveBeenCalledWith({ path: loaded, quiet: true });
  });

  it('falls back to the current-directory env file', () => {
    existsSync.mockReturnValueOnce(false).mockReturnValueOnce(true);

    const loaded = loadEnvFile();

    expect(loaded).toContain('/.env');
    expect(loadDotenvFile).toHaveBeenCalledOnce();
  });

  it('does nothing when configuration is supplied only through the environment', () => {
    existsSync.mockReturnValue(false);

    expect(loadEnvFile()).toBeNull();
    expect(loadDotenvFile).not.toHaveBeenCalled();
  });
});
