import { PrismaClient, TransactionState, CircuitState } from '@prisma/client';
import { CryptoUtil } from '../src/utils/crypto.util';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding database configurations...');

  // 1. Clean existing configurations
  await prisma.gatewayConfig.deleteMany({});
  await prisma.routingConfig.deleteMany({});
  await prisma.gatewayHealthMetrics.deleteMany({});

  // 2. Encrypt mock API keys
  const stripeKey = CryptoUtil.encrypt('sk_test_stripe_secret_key_12345');
  const stripeSecret = CryptoUtil.encrypt('whsec_stripe_test_secret');
  
  const razorpayKey = CryptoUtil.encrypt('rzp_test_razorpay_key_12345');
  const razorpaySecret = CryptoUtil.encrypt('whsec_razorpay_test_secret');
  
  const payuKey = CryptoUtil.encrypt('payu_test_api_key_12345');
  const payuSecret = CryptoUtil.encrypt('whsec_payu_test_secret');
  
  const upiKey = CryptoUtil.encrypt('upi_test_virtual_address_key');
  const upiSecret = CryptoUtil.encrypt('whsec_upi_test_secret');

  // 3. Create Gateway Configurations
  const gateways = [
    {
      name: 'Stripe',
      is_active: true,
      base_url: 'http://localhost:3000/api/v1/simulator/stripe',
      api_key: stripeKey,
      api_secret: stripeSecret,
      supported_methods: ['CARD'],
      success_rate: 0.98,
      avg_latency_ms: 220,
      cost_per_tx_paise: BigInt(20), // 20 paise fixed
      cost_percentage: 0.025,       // 2.5%
    },
    {
      name: 'Razorpay',
      is_active: true,
      base_url: 'http://localhost:3000/api/v1/simulator/razorpay',
      api_key: razorpayKey,
      api_secret: razorpaySecret,
      supported_methods: ['CARD', 'UPI', 'NETBANKING'],
      success_rate: 0.96,
      avg_latency_ms: 180,
      cost_per_tx_paise: BigInt(0),  // 0 fixed
      cost_percentage: 0.02,        // 2%
    },
    {
      name: 'PayU',
      is_active: true,
      base_url: 'http://localhost:3000/api/v1/simulator/payu',
      api_key: payuKey,
      api_secret: payuSecret,
      supported_methods: ['CARD', 'NETBANKING'],
      success_rate: 0.94,
      avg_latency_ms: 200,
      cost_per_tx_paise: BigInt(15), // 15 paise
      cost_percentage: 0.019,       // 1.9%
    },
    {
      name: 'UPI',
      is_active: true,
      base_url: 'http://localhost:3000/api/v1/simulator/upi',
      api_key: upiKey,
      api_secret: upiSecret,
      supported_methods: ['UPI'],
      success_rate: 0.97,
      avg_latency_ms: 110,
      cost_per_tx_paise: BigInt(0),  // 0 fixed
      cost_percentage: 0.003,       // 0.3%
    },
  ];

  for (const gw of gateways) {
    const config = await prisma.gatewayConfig.create({
      data: gw,
    });
    console.log(`Created config for gateway: ${config.name}`);

    // Create baseline health metrics for supported methods
    for (const method of gw.supported_methods) {
      await prisma.gatewayHealthMetrics.create({
        data: {
          gateway_name: gw.name,
          payment_method: method,
          state: CircuitState.CLOSED,
          failure_count: 0,
          success_count: 0,
          avg_latency_ms: gw.avg_latency_ms,
          success_rate: gw.success_rate,
        },
      });
      console.log(`Created health metrics baseline for ${gw.name} - ${method}`);
    }
  }

  // 4. Create Default Routing Weights & Priority Matrix
  const routing = await prisma.routingConfig.create({
    data: {
      success_rate_weight: 0.4,
      latency_weight: 0.2,
      cost_weight: 0.2,
      health_weight: 0.1,
      payment_method_fit_weight: 0.1,
      priority_matrix: {
        UPI: ['UPI', 'Razorpay'],
        CARD: ['Stripe', 'Razorpay', 'PayU'],
        NETBANKING: ['PayU', 'Razorpay'],
      },
    },
  });
  console.log('Seeded Default Routing Configuration:', routing);
}

main()
  .catch((e) => {
    console.error('Error during seed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
