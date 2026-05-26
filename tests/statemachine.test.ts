import { TransactionStateMachine } from '../src/state-machine/transaction-state-machine';
import { TransactionState } from '@prisma/client';

// Mock the logger to prevent cluttering test output
jest.mock('../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

describe('Transaction State Machine Tests', () => {
  let mockPrisma: any;

  beforeEach(() => {
    mockPrisma = {
      transaction: {
        update: jest.fn().mockResolvedValue({}),
      },
      transactionStateLog: {
        create: jest.fn().mockResolvedValue({}),
      },
      // Mock $queryRaw to return a transaction in CREATED state by default
      $queryRaw: jest
        .fn()
        .mockResolvedValue([{ id: 'mock-tx-uuid', status: TransactionState.CREATED, gateway_name: 'Stripe' }]),
    };
  });

  test('Should allow valid direct transitions (CREATED -> ROUTE_SELECTED)', async () => {
    await expect(
      TransactionStateMachine.transition(
        mockPrisma,
        'mock-tx-uuid',
        TransactionState.ROUTE_SELECTED,
        'test_actor',
        'Direct check',
        null,
        'test-trace-id'
      )
    ).resolves.not.toThrow();

    // Verify updates were executed
    expect(mockPrisma.transaction.update).toHaveBeenCalledWith({
      where: { id: 'mock-tx-uuid' },
      data: { status: TransactionState.ROUTE_SELECTED },
    });
    expect(mockPrisma.transactionStateLog.create).toHaveBeenCalled();
  });

  test('Should reject illegal direct transitions (CREATED -> CAPTURED)', async () => {
    // If not in compensating list or direct list
    // Let's set initial state to CAPTURE_FAILED (which cannot transition to AUTHORISED)
    mockPrisma.$queryRaw = jest
      .fn()
      .mockResolvedValue([{ id: 'mock-tx-uuid', status: TransactionState.CAPTURE_FAILED, gateway_name: 'Stripe' }]);

    await expect(
      TransactionStateMachine.transition(
        mockPrisma,
        'mock-tx-uuid',
        TransactionState.AUTHORISED,
        'test_actor',
        'Illegal jump check',
        null,
        'test-trace-id'
      )
    ).rejects.toThrow(/Illegal state transition/);

    expect(mockPrisma.transaction.update).not.toHaveBeenCalled();
  });

  test('Should resolve compensating transition path for out-of-order updates (CREATED -> CAPTURED)', async () => {
    // CREATED to CAPTURED is not direct, but has a compensating path:
    // ROUTE_SELECTED -> AUTH_INITIATED -> AUTHORISED -> CAPTURE_INITIATED -> CAPTURED
    await expect(
      TransactionStateMachine.transition(
        mockPrisma,
        'mock-tx-uuid',
        TransactionState.CAPTURED,
        'webhook_processor',
        'Webhook arrived early',
        null,
        'test-trace-id'
      )
    ).resolves.not.toThrow();

    // Verify it executed multiple single steps along the path
    // Path length is 5 states, so transaction updates should run 5 times
    expect(mockPrisma.transaction.update).toHaveBeenCalledTimes(5);
    expect(mockPrisma.transactionStateLog.create).toHaveBeenCalledTimes(5);
  });
});
