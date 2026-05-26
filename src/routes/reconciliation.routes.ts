import { Router } from 'express';
import { ReconciliationController } from '../controllers/reconciliation.controller';
import { authenticateApiKey } from '../middleware/auth.middleware';

const router = Router();

router.use(authenticateApiKey);

router.post('/trigger', ReconciliationController.triggerReconciliation);
router.get('/reports/:id', ReconciliationController.getReconciliationReport);
router.get('/anomalies', ReconciliationController.getActiveAnomalies);

export default router;
