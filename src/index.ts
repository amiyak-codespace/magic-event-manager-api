import './observability/bootstrap';
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { context, trace } from '@opentelemetry/api';

import authRoutes from './routes/auth';
import eventRoutes from './routes/events';
import rsvpRoutes from './routes/rsvps';
import invitationRoutes from './routes/invitations';
import aiRoutes from './routes/ai';
import notificationsRouter from './routes/notifications';
import billingRoutes from './routes/billing';
import ticketsRouter from './routes/tickets';
import agendaRouter from './routes/agenda';
import feedbackRouter from './routes/feedback';
import sponsorsRouter from './routes/sponsors';
import checkinRouter from './routes/checkin';
import campaignsRouter from './routes/campaigns';
import analyticsRouter from './routes/analytics';
import mediaRouter from './routes/media';
import pool from './utils/db';
import { logger, requestLogger } from './observability/logger';
import { processRecurringEvents } from './controllers/eventController';
import { processQueuedCampaignSends } from './controllers/campaignController';
import { cleanupNotifications } from './controllers/notificationsController';

const app = express();
const PORT = process.env.PORT || 5000;
app.disable('x-powered-by');

// Route legacy console logs through structured logger until all controllers are migrated.
console.log = (...args: unknown[]) => logger.info({ args }, 'console_log');
console.warn = (...args: unknown[]) => logger.warn({ args }, 'console_warn');
console.error = (...args: unknown[]) => logger.error({ args }, 'console_error');

const allowedOrigins = [
  process.env.FRONTEND_URL || 'http://localhost:3000',
  'https://events.appsmagic.in',
  'https://host-events.appsmagic.in',
  'https://magicevent.appsmagic.in',
  'https://eventmagic.appsmagic.in',
  'http://localhost:3000',
  'http://localhost:5173',
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));
app.use(requestLogger);
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if ((process.env.NODE_ENV || 'production') === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});
app.use((_req, res, next) => {
  const spanCtx = trace.getSpan(context.active())?.spanContext();
  if (spanCtx?.traceId) res.setHeader('x-trace-id', spanCtx.traceId);
  if (spanCtx?.spanId) res.setHeader('x-span-id', spanCtx.spanId);
  next();
});
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
const uploadsRoot = path.join(process.cwd(), 'uploads');
fs.mkdirSync(path.join(uploadsRoot, 'covers'), { recursive: true });
app.use('/api/uploads', express.static(uploadsRoot, { maxAge: '7d' }));

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected', timestamp: new Date().toISOString() });
  } catch {
    res.status(500).json({ status: 'error', db: 'disconnected' });
  }
});

app.use('/api/auth', authRoutes);
app.use('/api/events', eventRoutes);
app.use('/api/rsvps', rsvpRoutes);
app.use('/api/invitations', invitationRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/notifications', notificationsRouter);
app.use('/api/billing', billingRoutes);
app.use('/api/events/:eventId/tickets', ticketsRouter);
app.use('/api/events/:eventId/agenda', agendaRouter);
app.use('/api/events/:eventId/feedback', feedbackRouter);
app.use('/api/events/:eventId/sponsors', sponsorsRouter);
app.use('/api/events/:eventId/checkin', checkinRouter);
app.use('/api/campaigns', campaignsRouter);
app.use('/api/analytics', analyticsRouter);
app.use('/api/media', mediaRouter);

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error({ err }, 'unhandled_request_error');
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  logger.info({ port: Number(PORT) }, 'eventmagic_api_started');
});

setInterval(() => {
  void processRecurringEvents();
}, 60 * 1000);

setInterval(() => {
  void processQueuedCampaignSends();
}, Number(process.env.CAMPAIGN_WORKER_INTERVAL_MS || 30000));

setInterval(() => {
  void cleanupNotifications();
}, Number(process.env.NOTIFICATION_CLEANUP_INTERVAL_MS || 15 * 60 * 1000));

export default app;
