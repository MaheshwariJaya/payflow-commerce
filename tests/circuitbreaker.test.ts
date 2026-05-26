import { CircuitBreakerManager } from '../src/gateways/circuit-breaker.manager';
import { CircuitState } from '@prisma/client';
import { redis } from '../src/config/redis';

// Mock logger
jest.mock('../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// Mock Redis client
jest.mock('../src/config/redis', () => ({
  redis: {
    get: jest.fn(),
    set: jest.fn().mockResolvedValue('OK'),
    incr: jest.fn(),
    expire: jest.fn(),
  },
}));

describe('Circuit Breaker Manager Tests', () => {
  let mockPrisma: any;

  beforeEach(() => {
    jest.clearAllMocks();

    mockPrisma = {
      gatewayHealthMetrics: {
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
    };
  });

  test('Should return true if circuit state is CLOSED', async () => {
    (redis.get as jest.Mock).mockImplementation((key: string) => {
      if (key.endsWith(':state')) return Promise.resolve(CircuitState.CLOSED);
      if (key.endsWith(':last_change')) return Promise.resolve(new Date().toISOString());
      return Promise.resolve(null);
    });

    const isAvailable = await CircuitBreakerManager.isAvailable('Stripe', 'CARD', mockPrisma, 'test-trace');
    expect(isAvailable).toBe(true);
    expect(mockPrisma.gatewayHealthMetrics.findUnique).not.toHaveBeenCalled();
  });

  test('Should transition OPEN to HALF_OPEN after cooldown period has elapsed', async () => {
    const pastDate = new Date(Date.now() - 40000); // 40 seconds ago (cooldown is 30s)
    
    (redis.get as jest.Mock).mockImplementation((key: string) => {
      if (key.endsWith(':state')) return Promise.resolve(CircuitState.OPEN);
      if (key.endsWith(':last_change')) return Promise.resolve(pastDate.toISOString());
      return Promise.resolve(null);
    });

    const isAvailable = await CircuitBreakerManager.isAvailable('Stripe', 'CARD', mockPrisma, 'test-trace');
    
    // Cooldown elapsed, should trip to HALF_OPEN and return true
    expect(isAvailable).toBe(true);
    expect(redis.set).toHaveBeenCalledWith('cb:Stripe:CARD:state', CircuitState.HALF_OPEN);
    expect(mockPrisma.gatewayHealthMetrics.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          state: CircuitState.HALF_OPEN,
        }),
      })
    );
  });

  test('Should trip to OPEN immediately on failure in HALF_OPEN state', async () => {
    (redis.get as jest.Mock).mockResolvedValue(CircuitState.HALF_OPEN);
    (redis.incr as jest.Mock).mockResolvedValue(1);

    await CircuitBreakerManager.recordFailure('Stripe', 'CARD', 'Connection Timeout', mockPrisma, 'test-trace');

    expect(redis.set).toHaveBeenCalledWith('cb:Stripe:CARD:state', CircuitState.OPEN);
    expect(mockPrisma.gatewayHealthMetrics.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          state: CircuitState.OPEN,
        }),
      })
    );
  });

  test('Should close circuit (transition to CLOSED) after consecutive successes in HALF_OPEN', async () => {
    (redis.get as jest.Mock).mockResolvedValue(CircuitState.HALF_OPEN);
    // Mock consecutive successes to reach threshold (3)
    (redis.incr as jest.Mock).mockResolvedValue(3);

    await CircuitBreakerManager.recordSuccess('Stripe', 'CARD', 150, mockPrisma, 'test-trace');

    expect(redis.set).toHaveBeenCalledWith('cb:Stripe:CARD:state', CircuitState.CLOSED);
    expect(mockPrisma.gatewayHealthMetrics.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          state: CircuitState.CLOSED,
        }),
      })
    );
  });
});
