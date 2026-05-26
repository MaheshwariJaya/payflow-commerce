import { Request, Response, NextFunction } from 'express';
import { AnalyticsService } from '../services/analytics.service';
import { serializeBigInt } from '../utils/serialization';

export class AnalyticsController {
  public static async getSuccessRates(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const stats = await AnalyticsService.getSuccessRates();
      res.status(200).json(stats);
    } catch (err: any) {
      next(err);
    }
  }

  public static async getVolume(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const volume = await AnalyticsService.getVolume();
      res.status(200).json(volume);
    } catch (err: any) {
      next(err);
    }
  }

  public static async getDashboardStats(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const stats = await AnalyticsService.getDashboardStats();
      res.status(200).json(serializeBigInt(stats));
    } catch (err: any) {
      next(err);
    }
  }
}
