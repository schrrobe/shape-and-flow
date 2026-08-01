import { Global, Module } from '@nestjs/common';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';

import { ENV } from '../../config/env.schema.js';
import { correlationId } from '../correlation/correlation.store.js';

import { REDACT_CENSOR, REDACT_PATHS } from './redaction.js';

import type { AppConfig } from '../../config/env.schema.js';
import type { Params } from 'nestjs-pino';

/**
 * Structured logging, with redaction and the correlation id attached.
 *
 * Pretty printing is development-only. In every other environment the output is
 * one JSON object per line, because that is what a log shipper can index and what
 * makes `correlationId` searchable.
 */
export function buildLoggerParams(config: AppConfig): Params {
  const isDevelopment = config.NODE_ENV === 'development';

  return {
    pinoHttp: {
      level: config.LOG_LEVEL,
      redact: { paths: [...REDACT_PATHS], censor: REDACT_CENSOR, remove: false },
      // Reuse the id the correlation middleware already established, so the
      // request log and every line inside the request agree.
      genReqId: () => correlationId(),
      customProps: () => ({ correlationId: correlationId() }),
      autoLogging: {
        // Health probes would otherwise dominate the log volume.
        ignore: (request) => request.url?.startsWith('/api/health') === true,
      },
      ...(isDevelopment
        ? {
            transport: {
              target: 'pino-pretty',
              options: { singleLine: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
            },
          }
        : {}),
    },
  };
}

@Global()
@Module({
  imports: [
    PinoLoggerModule.forRootAsync({
      inject: [ENV],
      useFactory: (config: AppConfig) => buildLoggerParams(config),
    }),
  ],
})
export class LoggingModule {}
