import { Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { CryptoUtil } from '../utils/crypto.util';
import { serializeBigInt } from '../utils/serialization';
import { GatewayRateLimiter } from '../middleware/rate-limiter';
import { logger } from '../utils/logger';

const prisma = new PrismaClient();

export class ConfigController {
  public static async getGateways(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const gateways = await prisma.gatewayConfig.findMany({});

      const sanitized = gateways.map((gw) => ({
        ...gw,
        api_key: '[MASKED]',
        api_secret: gw.api_secret ? '[MASKED]' : null,
      }));

      res.status(200).json(serializeBigInt(sanitized));
    } catch (err: any) {
      next(err);
    }
  }

  public static async getGatewayHealth(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { name } = req.params;
      const metrics = await prisma.gatewayHealthMetrics.findMany({
        where: { gateway_name: { equals: name, mode: 'insensitive' } },
      });

      if (metrics.length === 0) {
        res.status(404).json({
          error: 'Not Found',
          message: `No health metrics found for gateway: ${name}`,
        });
        return;
      }

      res.status(200).json(serializeBigInt(metrics));
    } catch (err: any) {
      next(err);
    }
  }

  public static async getGatewayMetrics(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { name } = req.params;
      const config = await prisma.gatewayConfig.findFirst({
        where: { name: { equals: name, mode: 'insensitive' } },
      });

      if (!config) {
        res.status(404).json({
          error: 'Not Found',
          message: `Gateway config ${name} not found.`,
        });
        return;
      }

      res.status(200).json({
        gateway: config.name,
        success_rate: config.success_rate,
        avg_latency_ms: config.avg_latency_ms,
        cost_per_tx_paise: config.cost_per_tx_paise.toString(),
        cost_percentage: config.cost_percentage,
      });
    } catch (err: any) {
      next(err);
    }
  }

  public static async updateGatewayConfig(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { name } = req.params;
      const {
        is_active,
        base_url,
        api_key,
        api_secret,
        supported_methods,
        cost_per_tx_paise,
        cost_percentage,
        rate_limit_capacity,
        rate_limit_refill,
      } = req.body;

      const existing = await prisma.gatewayConfig.findFirst({
        where: { name: { equals: name, mode: 'insensitive' } },
      });

      if (!existing) {
        res.status(404).json({
          error: 'Not Found',
          message: `Gateway config ${name} not found.`,
        });
        return;
      }

      const updateData: any = {};
      if (is_active !== undefined) updateData.is_active = is_active;
      if (base_url !== undefined) updateData.base_url = base_url;
      if (supported_methods !== undefined) updateData.supported_methods = supported_methods;
      if (cost_percentage !== undefined) updateData.cost_percentage = cost_percentage;

      if (cost_per_tx_paise !== undefined) {
        updateData.cost_per_tx_paise = BigInt(cost_per_tx_paise);
      }

      if (api_key) {
        updateData.api_key = CryptoUtil.encrypt(api_key);
      }
      if (api_secret) {
        updateData.api_secret = CryptoUtil.encrypt(api_secret);
      }

      const updated = await prisma.gatewayConfig.update({
        where: { id: existing.id },
        data: updateData,
      });

      if (rate_limit_capacity && rate_limit_refill) {
        GatewayRateLimiter.setLimit(updated.name, rate_limit_capacity, rate_limit_refill);
      }

      logger.info(`Updated gateway config for ${updated.name}`, {
        updated_by: 'admin',
      });

      res.status(200).json(
        serializeBigInt({
          ...updated,
          api_key: '[MASKED]',
          api_secret: updated.api_secret ? '[MASKED]' : null,
        }),
      );
    } catch (err: any) {
      logger.error(`Failed to update config for ${req.params.name}`, {
        error: err.message,
      });
      next(err);
    }
  }

  public static async getRoutingConfig(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const config = await prisma.routingConfig.findFirst();
      res.status(200).json(config);
    } catch (err: any) {
      next(err);
    }
  }

  public static async updateRoutingConfig(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const {
        success_rate_weight,
        latency_weight,
        cost_weight,
        health_weight,
        payment_method_fit_weight,
        priority_matrix,
      } = req.body;

      const existing = await prisma.routingConfig.findFirst();

      const data = {
        success_rate_weight,
        latency_weight,
        cost_weight,
        health_weight,
        payment_method_fit_weight,
        priority_matrix,
      };

      let updated;
      if (existing) {
        updated = await prisma.routingConfig.update({
          where: { id: existing.id },
          data,
        });
      } else {
        updated = await prisma.routingConfig.create({
          data,
        });
      }

      logger.info('Updated routing engine parameters', { updated_by: 'admin' });
      res.status(200).json(updated);
    } catch (err: any) {
      next(err);
    }
  }
}
