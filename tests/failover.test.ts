import { PaymentService } from '../src/services/payment.service';
import { RoutingEngine } from '../src/routing-engine/routing-engine';
import { GatewayFactory } from '../src/gateways/gateway.factory';
import { GatewayRateLimiter } from '../src/middleware/rate-limiter';
import { CircuitBreakerManager } from '../src/gateways/circuit-breaker.manager';
import { TransactionState } from '@prisma/client';

jest.mock('../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
  setLogContext: jest.fn(),
}));

jest.mock('../src/routing-engine/routing-engine');
jest.mock('../src/middleware/rate-limiter');
jest.mock('../src/gateways/circuit-breaker.manager');

const mockCreate = (global as any).mockCreate;
const mockUpdate = (global as any).mockUpdate;
const mockFindUnique = (global as any).mockFindUnique;
const mockStateLogCreate = (global as any).mockStateLogCreate;
const mockTransaction = (global as any).mockTransaction;
const mockQueryRaw = (global as any).mockQueryRaw;

const mockStripeAdapter = {
  name: 'Stripe',
  initializePayment: jest.fn(),
};

const mockRazorpayAdapter = {
  name: 'Razorpay',
  initializePayment: jest.fn(),
};

jest.mock('../src/gateways/gateway.factory', () => ({
  GatewayFactory: {
    getAdapter: jest.fn().mockImplementation((name: string) => {
      if (name.toLowerCase() === 'stripe') return mockStripeAdapter;
      if (name.toLowerCase() === 'razorpay') return mockRazorpayAdapter;
      throw new Error('Adapter not found');
    }),
  },
}));

describe('Orchestration Failover & Timeout Tests', () => {
  beforeEach(() => {
    mockTransaction.mockImplementation(async (callback: any) => {
      return callback({
        transaction: {
          create: mockCreate,
          update: mockUpdate,
          findUnique: mockFindUnique,
        },
        transactionStateLog: {
          create: mockStateLogCreate,
        },
        $queryRaw: mockQueryRaw,
      });
    });

    mockCreate.mockResolvedValue({
      id: 'tx-uuid-123',
      amount_paise: BigInt(5000),
      currency: 'INR',
      status: TransactionState.CREATED,
    });
    mockUpdate.mockResolvedValue({});
    mockFindUnique.mockResolvedValue({});
    mockStateLogCreate.mockResolvedValue({});
    mockQueryRaw.mockResolvedValue([
      {
        id: 'tx-uuid-123',
        status: TransactionState.CREATED,
        gateway_name: 'Stripe',
      },
    ]);

    (GatewayFactory.getAdapter as jest.Mock).mockImplementation((name: string) => {
      if (name.toLowerCase() === 'stripe') return mockStripeAdapter;
      if (name.toLowerCase() === 'razorpay') return mockRazorpayAdapter;
      throw new Error('Adapter not found');
    });

    (GatewayRateLimiter.tryAcquire as jest.Mock).mockResolvedValue(true);
    (CircuitBreakerManager.isAvailable as jest.Mock).mockResolvedValue(true);
  });

  test('Should failover to Razorpay when Stripe times out', async () => {
    (RoutingEngine.selectRoute as jest.Mock).mockResolvedValue([
      { gatewayName: 'Stripe', score: 0.9, circuitState: 'CLOSED' },
      { gatewayName: 'Razorpay', score: 0.8, circuitState: 'CLOSED' },
    ]);

    mockStripeAdapter.initializePayment.mockImplementation(() => {
      return new Promise((resolve) => setTimeout(resolve, 2500));
    });

    mockRazorpayAdapter.initializePayment.mockResolvedValue({
      success: true,
      gatewayReferenceId: 'pay_razorpay_ref',
      status: 'authorised',
      rawResponse: {},
    });

    await PaymentService.createPayment(
      BigInt(5000),
      'INR',
      'CARD',
      'cust_123',
      'order_123',
      'idemp_123',
      null,
      'trace_123',
    );

    expect(mockStripeAdapter.initializePayment).toHaveBeenCalled();
    expect(CircuitBreakerManager.recordFailure).toHaveBeenCalledWith(
      'Stripe',
      'CARD',
      expect.stringContaining('timed out'),
      expect.any(Object),
      'trace_123',
    );

    expect(mockRazorpayAdapter.initializePayment).toHaveBeenCalled();
    expect(CircuitBreakerManager.recordSuccess).toHaveBeenCalledWith(
      'Razorpay',
      'CARD',
      expect.any(Number),
      expect.any(Object),
      'trace_123',
    );
  });
});
