import { Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { ReconciliationService } from '../services/reconciliation.service';
import { serializeBigInt } from '../utils/serialization';
import { logger } from '../utils/logger';

const prisma = new PrismaClient();

export class ReconciliationController {
  /**
   * POST /api/v1/reconciliation/trigger
   */
  public static async triggerReconciliation(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const traceId = (res.getHeader('X-Trace-ID') as string) || 'default-trace';

      const count = await ReconciliationService.triggerBulkReconciliation(traceId);

      logger.info(`Bulk reconciliation run triggered`, { enqueued_jobs_count: count });
      res.status(202).json({
        message: 'Bulk reconciliation processing triggered successfully.',
        enqueued_jobs: count,
      });
    } catch (err: any) {
      next(err);
    }
  }

  /**
   * GET /api/v1/reconciliation/reports/:id
   */
  public static async getReconciliationReport(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id } = req.params;

      const anomaly = await prisma.reconciliationAnomaly.findUnique({
        where: { id },
      });

      if (!anomaly) {
        res.status(404).json({ error: 'Not Found', message: `Reconciliation anomaly with ID ${id} not found.` });
        return;
      }

      res.status(200).json(serializeBigInt(anomaly));
    } catch (err: any) {
      next(err);
    }
  }

  /**
   * GET /api/v1/reconciliation/anomalies
   */
  public static async getActiveAnomalies(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const anomalies = await prisma.reconciliationAnomaly.findMany({
        where: { resolved: false },
        orderBy: { created_at: 'desc' },
      });

      res.status(200).json(serializeBigInt(anomalies));
    } catch (err: any) {
      next(err);
    }
  }
}
