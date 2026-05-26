import { Router } from 'express';
import { ConfigController } from '../controllers/config.controller';
import { authenticateApiKey } from '../middleware/auth.middleware';

const router = Router();

router.use(authenticateApiKey);

router.get('/gateways', ConfigController.getGateways);
router.get('/gateways/:name/health', ConfigController.getGatewayHealth);
router.get('/gateways/:name/metrics', ConfigController.getGatewayMetrics);
router.put('/gateways/:name/config', ConfigController.updateGatewayConfig);

router.get('/routing/config', ConfigController.getRoutingConfig);
router.put('/routing/config', ConfigController.updateRoutingConfig);

export default router;
