import { EventEmitter } from 'events';

class MockRedis extends EventEmitter {
  public options = {};
  public status = 'ready';

  constructor() {
    super();
  }

  public get = jest.fn().mockResolvedValue(null);
  public set = jest.fn().mockResolvedValue('OK');
  public incr = jest.fn().mockResolvedValue(1);
  public eval = jest.fn().mockResolvedValue(1);
  public expire = jest.fn().mockResolvedValue(1);
  public info = jest.fn().mockResolvedValue('redis_version:7.0.0\n');
  public defineCommand = jest.fn();
  public quit = jest.fn().mockResolvedValue('OK');
  public disconnect = jest.fn();
  public connect = jest.fn().mockResolvedValue(undefined);
  public ping = jest.fn().mockResolvedValue('PONG');
}

const MockRedisConstructor = jest.fn().mockImplementation(() => {
  return new MockRedis();
});

// Enforce default export compatibility
(MockRedisConstructor as any).default = MockRedisConstructor;

jest.mock('ioredis', () => MockRedisConstructor);

// Define global prisma mock functions to prevent crossed mock functions across files
const mockCreate = jest.fn();
const mockUpdate = jest.fn();
const mockFindUnique = jest.fn();
const mockStateLogCreate = jest.fn();
const mockTransaction = jest.fn();
const mockQueryRaw = jest.fn().mockResolvedValue([{ id: 'mock-tx-uuid', status: 'CREATED', gateway_name: 'Stripe' }]);

(global as any).mockCreate = mockCreate;
(global as any).mockUpdate = mockUpdate;
(global as any).mockFindUnique = mockFindUnique;
(global as any).mockStateLogCreate = mockStateLogCreate;
(global as any).mockTransaction = mockTransaction;
(global as any).mockQueryRaw = mockQueryRaw;

jest.mock('@prisma/client', () => {
  return {
    PrismaClient: jest.fn().mockImplementation(() => ({
      transaction: {
        create: (global as any).mockCreate,
        update: (global as any).mockUpdate,
        findUnique: (global as any).mockFindUnique,
      },
      transactionStateLog: {
        create: (global as any).mockStateLogCreate,
      },
      idempotencyKey: {
        create: (global as any).mockCreate,
        update: (global as any).mockUpdate,
        findUnique: (global as any).mockFindUnique,
      },
      $transaction: (global as any).mockTransaction,
      $queryRaw: (global as any).mockQueryRaw,
    })),
    TransactionState: {
      CREATED: 'CREATED',
      ROUTE_SELECTED: 'ROUTE_SELECTED',
      AUTH_INITIATED: 'AUTH_INITIATED',
      AUTHORISED: 'AUTHORISED',
      AUTH_FAILED: 'AUTH_FAILED',
      CAPTURE_INITIATED: 'CAPTURE_INITIATED',
      CAPTURED: 'CAPTURED',
      PARTIALLY_CAPTURED: 'PARTIALLY_CAPTURED',
      CAPTURE_FAILED: 'CAPTURE_FAILED',
      REFUND_INITIATED: 'REFUND_INITIATED',
      REFUNDED: 'REFUNDED',
      FAILED: 'FAILED',
      VOID_INITIATED: 'VOID_INITIATED',
      VOIDED: 'VOIDED',
      AUTH_EXPIRED: 'AUTH_EXPIRED',
      PARTIALLY_REFUNDED: 'PARTIALLY_REFUNDED',
      REFUND_FAILED: 'REFUND_FAILED',
      SETTLED: 'SETTLED',
    },
    CircuitState: {
      CLOSED: 'CLOSED',
      OPEN: 'OPEN',
      HALF_OPEN: 'HALF_OPEN',
    },
  };
});

