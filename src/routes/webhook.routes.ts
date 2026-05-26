import { Router } from 'express';
import { WebhookController } from '../controllers/webhook.controller';
import { authenticateApiKey } from '../middleware/auth.middleware';

const router = Router();

router.post('/stripe', WebhookController.processStripeWebhook);
router.post('/razorpay', WebhookController.processRazorpayWebhook);
router.post('/payu', WebhookController.processPayUWebhook);
router.post('/upi', WebhookController.processUPIWebhook);

router.post('/replay/:event_id', authenticateApiKey, WebhookController.replayWebhook);

export default router;
