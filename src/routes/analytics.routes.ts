import { Router } from 'express';
import { AnalyticsController } from '../controllers/analytics.controller';
import { authenticateApiKey } from '../middleware/auth.middleware';

const router = Router();

router.use(authenticateApiKey);

router.get('/success-rate', AnalyticsController.getSuccessRates);
router.get('/volume', AnalyticsController.getVolume);
router.get('/dashboard', AnalyticsController.getDashboardStats);

export default router;
