import { RoutingEngine } from '../src/routing-engine/routing-engine';
import { CircuitState } from '@prisma/client';

// Mock logger
jest.mock('../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

describe('Routing Engine Scoring Tests', () => {
  let mockPrisma: any;

  beforeEach(() => {
    // Setup default seed configs
    mockPrisma = {
      gatewayConfig: {
        findMany: jest.fn().mockResolvedValue([
          {
            name: 'Stripe',
            is_active: true,
            supported_methods: ['CARD'],
            success_rate: 0.98,
            avg_latency_ms: 200,
            cost_per_tx_paise: BigInt(20),
            cost_percentage: 0.02,
          },
          {
            name: 'Razorpay',
            is_active: true,
            supported_methods: ['CARD', 'UPI'],
            success_rate: 0.95,
            avg_latency_ms: 100,
            cost_per_tx_paise: BigInt(0),
            cost_percentage: 0.015,
          },
        ]),
      },
      routingConfig: {
        findFirst: jest.fn().mockResolvedValue({
          success_rate_weight: 0.4,
          latency_weight: 0.3,
          cost_weight: 0.1,
          health_weight: 0.1,
          payment_method_fit_weight: 0.1,
          priority_matrix: {
            CARD: ['Stripe', 'Razorpay'],
            UPI: ['Razorpay'],
          },
        }),
      },
      gatewayHealthMetrics: {
        findMany: jest.fn().mockResolvedValue([
          {
            gateway_name: 'Stripe',
            payment_method: 'CARD',
            state: CircuitState.CLOSED,
            success_rate: 0.98,
            avg_latency_ms: 200,
          },
          {
            gateway_name: 'Razorpay',
            payment_method: 'CARD',
            state: CircuitState.CLOSED,
            success_rate: 0.95,
            avg_latency_ms: 100,
          },
        ]),
      },
    };
  });

  test('Should rank Razorpay higher for CARD due to lower latency and cost', async () => {
    const routes = await RoutingEngine.selectRoute(
      mockPrisma,
      BigInt(10000), // 100 INR
      'INR',
      'CARD',
      'test-trace-id'
    );

    expect(routes.length).toBe(2);
    // Razorpay has 100ms latency (min) vs Stripe 200ms.
    // Razorpay cost is 0 + 1.5%*100 = 1.50 INR vs Stripe 20c + 2%*100 = 2.20 INR.
    // Razorpay should have a higher latency score (1 - 0 = 1) and cost score (1 - 0 = 1)
    // and thus score higher despite Stripe's slightly higher success rate.
    expect(routes[0].gatewayName).toBe('Razorpay');
  });

  test('Should filter out gateways that do not support the requested method', async () => {
    const routes = await RoutingEngine.selectRoute(mockPrisma, BigInt(10000), 'INR', 'UPI', 'test-trace-id');

    // Only Razorpay supports UPI in our mocked config
    expect(routes.length).toBe(1);
    expect(routes[0].gatewayName).toBe('Razorpay');
  });

  test('Should place OPEN circuit gateways at the bottom of the list', async () => {
    // Trip Razorpay's circuit breaker to OPEN
    mockPrisma.gatewayHealthMetrics.findMany = jest.fn().mockResolvedValue([
      {
        gateway_name: 'Stripe',
        payment_method: 'CARD',
        state: CircuitState.CLOSED,
        success_rate: 0.98,
        avg_latency_ms: 200,
      },
      {
        gateway_name: 'Razorpay',
        payment_method: 'CARD',
        state: CircuitState.OPEN, // Tripped!
        success_rate: 0.95,
        avg_latency_ms: 100,
      },
    ]);

    const routes = await RoutingEngine.selectRoute(mockPrisma, BigInt(10000), 'INR', 'CARD', 'test-trace-id');

    // Stripe should now be first because Razorpay is OPEN
    expect(routes[0].gatewayName).toBe('Stripe');
    expect(routes[1].gatewayName).toBe('Razorpay');
    expect(routes[1].circuitState).toBe(CircuitState.OPEN);
  });
});
