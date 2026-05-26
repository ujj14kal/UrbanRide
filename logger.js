// logger.js — Structured JSON logger (Winston)
//
// Why Winston + JSON over console.log:
//   • Every log line is a parseable JSON object — queryable in Datadog / CloudWatch / ELK
//   • Severity levels (info / warn / error) let ops teams filter noise from alerts
//   • `defaultMeta` stamps every line with { service, env } for multi-service tracing
//   • In development, colourised simple format keeps DX fast; in production, pure JSON
//
// Swap the single Console transport for a File or Datadog transport with zero app changes.

const { createLogger, format, transports } = require('winston');
const { combine, timestamp, errors, json, colorize, printf } = format;

const isDev = process.env.NODE_ENV !== 'production';

// ── Development format — readable, colourised ──────────────────────────────────
const devFormat = combine(
  colorize({ all: true }),
  timestamp({ format: 'HH:mm:ss' }),
  errors({ stack: true }),
  printf(({ level, message, timestamp, ...meta }) => {
    const extra = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
    return `${timestamp} [${level}] ${message}${extra}`;
  })
);

// ── Production format — structured JSON for log aggregators ───────────────────
const prodFormat = combine(
  errors({ stack: true }),
  timestamp({ format: 'YYYY-MM-DDTHH:mm:ss.SSSZ' }),
  json()
);

const logger = createLogger({
  level:       process.env.LOG_LEVEL || 'info',
  format:      isDev ? devFormat : prodFormat,
  defaultMeta: { service: 'urbanride', env: process.env.NODE_ENV || 'development' },
  transports:  [new transports.Console()]
});

module.exports = logger;
