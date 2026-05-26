import { Router } from 'express';
import { PaymentController } from '../controllers/payment.controller';
import { idempotency } from '../middleware/idempotency.middleware';
import { authenticateJWTOrApiKey } from '../middleware/auth.middleware';

const router = Router();

// Apply Dual JWT/API Key Authentication to all payment routes
router.use(authenticateJWTOrApiKey);

router.post('/', idempotency(), PaymentController.createPayment);
router.get('/', PaymentController.listPayments);
router.get('/:id', PaymentController.getPaymentDetails);
router.post('/:id/capture', PaymentController.capturePayment);
router.post('/:id/refund', PaymentController.refundPayment);
router.post('/:id/void', PaymentController.voidPayment);
router.get('/:id/timeline', PaymentController.getTimeline);

export default router;

