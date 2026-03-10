import fs from 'fs';
import path from 'path';
import pino from 'pino';
import pinoHttp from 'pino-http';
import { context, propagation, trace } from '@opentelemetry/api';

const logsDir = process.env.LOG_DIR || path.join(process.cwd(), 'logs');
const logFile = process.env.LOG_FILE || path.join(logsDir, 'eventmagic-api.log');

if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const destination = pino.destination({
  dest: logFile,
  sync: false,
  minLength: 4096,
});

function activeTelemetryFields() {
  const span = trace.getSpan(context.active());
  const spanCtx = span?.spanContext();
  const baggage = propagation.getBaggage(context.active());

  const baggageObj = baggage
    ? Object.fromEntries(
        baggage.getAllEntries().map(([k, v]) => [k, v.value])
      )
    : undefined;

  return {
    trace_id: spanCtx?.traceId,
    span_id: spanCtx?.spanId,
    baggage: baggageObj,
  };
}

export const logger = pino(
  {
    level: process.env.LOG_LEVEL || 'info',
    base: {
      service: process.env.OTEL_SERVICE_NAME || 'magic-event-api',
      env: process.env.NODE_ENV || 'development',
    },
    messageKey: 'message',
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
    mixin() {
      return activeTelemetryFields();
    },
  },
  destination
);

export const requestLogger = pinoHttp({
  logger,
  genReqId(req, res) {
    const incoming = req.headers['x-correlation-id'];
    const id = typeof incoming === 'string' && incoming.trim() ? incoming.trim() : cryptoRandomId();
    res.setHeader('x-correlation-id', id);
    return id;
  },
  customProps(req) {
    return {
      correlation_id: req.id,
      http_target: req.url,
      user_agent: req.headers['user-agent'] || null,
    };
  },
  customLogLevel(_req, res, err) {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  serializers: {
    req(req) {
      return {
        id: req.id,
        method: req.method,
        url: req.url,
      };
    },
    res(res) {
      return {
        statusCode: res.statusCode,
      };
    },
  },
});

function cryptoRandomId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
