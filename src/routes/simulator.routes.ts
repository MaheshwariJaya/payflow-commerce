import { Router } from 'express';
import { SimulatorController } from '../controllers/simulator.controller';

const router = Router();

// Public simulator routes representing sandbox networks
router.post('/stripe/v1/payment_intents', SimulatorController.stripePaymentIntents);
router.post('/razorpay/v1/orders', SimulatorController.razorpayOrders);
router.post('/payu/_payment', SimulatorController.payuPayment);
router.post('/upi/pay', SimulatorController.upiPay);

export default router;
