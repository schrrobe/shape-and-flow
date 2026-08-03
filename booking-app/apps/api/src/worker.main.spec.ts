import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const worker = vi.hoisted(() => ({
  app: {
    close: vi.fn().mockResolvedValue(undefined),
    flushLogs: vi.fn(),
    get: vi.fn(),
    useLogger: vi.fn(),
  },
  logger: { error: vi.fn(), log: vi.fn() },
  registrar: {
    handledJobNames: vi.fn().mockReturnValue([]),
    start: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
  },
  scheduler: {
    install: vi.fn().mockRejectedValue(new Error('redis unavailable')),
    installed: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('@nestjs/core', () => ({
  NestFactory: { createApplicationContext: vi.fn().mockResolvedValue(worker.app) },
}));
vi.mock('nestjs-pino', () => ({ Logger: Symbol('PinoLogger') }));
vi.mock('./config/env.schema.js', () => ({
  assertAppRole: vi.fn(),
  loadConfig: vi.fn().mockReturnValue({ NODE_ENV: 'test' }),
}));
vi.mock('./config/load-dotenv.js', () => ({ loadEnvFile: vi.fn().mockReturnValue(null) }));
vi.mock('./messaging/queues/scheduler.service.js', () => ({
  SchedulerService: Symbol('SchedulerService'),
}));
vi.mock('./messaging/queues/worker-registrar.service.js', () => ({
  WorkerRegistrarService: Symbol('WorkerRegistrarService'),
}));
vi.mock('./worker.module.js', () => ({ WorkerModule: Symbol('WorkerModule') }));

describe('worker bootstrap failure', () => {
  const rejectionHandlersBefore = new Set(process.listeners('unhandledRejection'));
  const exceptionHandlersBefore = new Set(process.listeners('uncaughtException'));
  beforeAll(() => {
    worker.app.get
      .mockReturnValueOnce(worker.logger)
      .mockReturnValueOnce(worker.registrar)
      .mockReturnValueOnce(worker.scheduler);
  });

  afterAll(() => {
    for (const handler of process.listeners('unhandledRejection')) {
      if (!rejectionHandlersBefore.has(handler))
        process.removeListener('unhandledRejection', handler);
    }
    for (const handler of process.listeners('uncaughtException')) {
      if (!exceptionHandlersBefore.has(handler))
        process.removeListener('uncaughtException', handler);
    }
  });

  it('closes the created application context before exiting non-zero', async () => {
    const failure = await import('./worker.main.js').then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(String(failure)).toContain('process.exit unexpectedly called with "1"');
    expect(worker.logger.error).toHaveBeenCalledWith(expect.stringContaining('redis unavailable'));
    expect(worker.registrar.stop).toHaveBeenCalledOnce();
    expect(worker.app.close).toHaveBeenCalledOnce();
  });
});
