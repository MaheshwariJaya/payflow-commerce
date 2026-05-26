import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import * as jwt from 'jsonwebtoken';
import swaggerUi from 'swagger-ui-express';

import { traceMiddleware } from './middleware/trace.middleware';
import { apiRateLimiter } from './middleware/rate-limiter';
import { telemetryMiddleware, register } from './config/telemetry';
import { openapiSpec } from './swagger/openapi';
import { logger } from './utils/logger';

import paymentRoutes from './routes/payment.routes';
import webhookRoutes from './routes/webhook.routes';
import configRoutes from './routes/config.routes';
import reconciliationRoutes from './routes/reconciliation.routes';
import analyticsRoutes from './routes/analytics.routes';
import simulatorRoutes from './routes/simulator.routes';

const app = express();

app.use(helmet());
app.use(cors());

app.use(
  express.json({
    verify: (req: any, res, buf) => {
      req.rawBody = buf.toString();
    },
  }),
);
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  const originalJson = res.json;
  res.json = function (body: any) {
    if (body && typeof body === 'object' && body.error && !body.error.code) {
      const rawError = body.error;
      const code =
        typeof rawError === 'string'
          ? rawError.toUpperCase().replace(/[^A-Z0-9_]/g, '_')
          : body.code || 'INTERNAL_SERVER_ERROR';

      const message = body.message || (typeof rawError === 'string' ? rawError : 'An error occurred');
      const details = body.details || (body.statusCode ? { statusCode: body.statusCode } : {});

      body = {
        error: {
          code,
          message,
          details,
        },
      };
    }
    return originalJson.call(this, body);
  };
  next();
});

app.use(traceMiddleware);
app.use(telemetryMiddleware);

app.use('/api/v1/payments', apiRateLimiter);

app.post('/api/v1/auth/token', (req, res) => {
  const { customer_id } = req.body;
  if (!customer_id) {
    res.status(400).json({
      error: 'Bad Request',
      message: 'Missing customer_id parameter in body',
    });
    return;
  }

  const token = jwt.sign(
    { customer_id, scope: 'transactions:write' },
    process.env.JWT_SECRET || 'supersecretjwtkeyforpayflow',
    { expiresIn: '24h' },
  );

  res.status(200).json({
    access_token: token,
    token_type: 'Bearer',
    expires_in: 86400,
  });
});

app.use('/api/v1/payments', paymentRoutes);
app.use('/api/v1/webhooks', webhookRoutes);
app.use('/api/v1/config', configRoutes);
app.use('/api/v1/reconciliation', reconciliationRoutes);
app.use('/api/v1/analytics', analyticsRoutes);

app.use('/api/v1/simulator', simulatorRoutes);

app.use('/dashboard', express.static('public'));

app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(openapiSpec));

app.get('/metrics', async (req, res) => {
  try {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  } catch (err: any) {
    res.status(500).end(err.message);
  }
});

app.get('/api/v1/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime_seconds: process.uptime(),
  });
});

app.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = err.statusCode || err.status || 500;
  const message = err.message || 'Internal Server Error';

  logger.error('Unhandled request exception', {
    error: message,
    stack: err.stack,
    path: req.path,
    method: req.method,
  });

  res.status(status).json({
    error: err.name || 'InternalServerError',
    message,
    statusCode: status,
  });
});

export default app;
