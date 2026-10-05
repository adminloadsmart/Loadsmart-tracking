import pino, { Logger } from 'pino';
import { env } from '../config/env';

// One root logger for the process; roles and requests derive child loggers from it so every line
// carries its role / requestId. Pretty-printed in development, newline-delimited JSON elsewhere
// (what log shippers expect).
export const logger: Logger = pino({
  level: env.logLevel,
  base: { service: env.serviceName },
  timestamp: pino.stdTimeFunctions.isoTime,
  ...(env.nodeEnv === 'development'
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' },
        },
      }
    : {}),
});

export type { Logger };
