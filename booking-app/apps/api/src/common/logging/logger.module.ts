import { Global, Module } from '@nestjs/common';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';

import { ENV } from '../../config/env.schema.js';
import { correlationId } from '../correlation/correlation.store.js';

import { REDACT_CENSOR, REDACT_PATHS } from './redaction.js';
import {
  requestLogLevel,
  requestLogProps,
  requestOutcomeProps,
  serializeRequest,
  serializeResponse,
  shouldSkipRequestLog,
} from './request-log.js';

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
      // The one line per request, and the fields it is searched by. See
      // request-log.ts for why this is pino's automatic log rather than the Nest
      // interceptor the plan describes.
      customProps: (request) => requestLogProps(request),
      // The status goes only on the lines that complete a request: everywhere else
      // the response has not been written yet and would report a 200 it never sent.
      customSuccessObject: (_request, response, value: object) => ({
        ...value,
        ...requestOutcomeProps(response),
      }),
      customErrorObject: (_request, response, _error, value: object) => ({
        ...value,
        ...requestOutcomeProps(response),
      }),
      customLogLevel: (_request, response, error) => requestLogLevel(response.statusCode, error),
      // pino-http renames it on the way out; `responseTimeMs` says what the number
      // is without the reader having to know pino's conventions.
      customAttributeKeys: { responseTime: 'responseTimeMs' },
      // Deliberately narrower than pino's defaults — see request-log.ts. The short
      // version: the default response serializer would put `Set-Cookie` in the log.
      serializers: { req: serializeRequest, res: serializeResponse },
      autoLogging: {
        ignore: (request) => shouldSkipRequestLog(request.url, config.LOG_SAMPLE_RATE),
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
