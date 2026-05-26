import app from './app';
import { startTelemetry } from './config/telemetry';
import { logger } from './utils/logger';

startTelemetry();

const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, () => {
  logger.info(`PayFlow Commerce Payment Orchestration server listening on port ${PORT}`, {
    url: `http://localhost:${PORT}`,
    swagger: `http://localhost:${PORT}/api-docs`,
    metrics: `http://localhost:${PORT}/metrics`,
  });
});

function handleShutdown(signal: string) {
  logger.info(`Received ${signal}. Shutting down gracefully...`);
  server.close(() => {
    logger.info('HTTP server closed.');
    process.exit(0);
  });
}

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));
