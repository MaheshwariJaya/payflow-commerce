import { TransactionStateMachine } from '../src/state-machine/transaction-state-machine';
import { TransactionState } from '@prisma/client';

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

      $queryRaw: jest.fn().mockResolvedValue([
        {
          id: 'mock-tx-uuid',
          status: TransactionState.CREATED,
          gateway_name: 'Stripe',
        },
      ]),
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
        'test-trace-id',
      ),
    ).resolves.not.toThrow();

    expect(mockPrisma.transaction.update).toHaveBeenCalledWith({
      where: { id: 'mock-tx-uuid' },
      data: { status: TransactionState.ROUTE_SELECTED },
    });
    expect(mockPrisma.transactionStateLog.create).toHaveBeenCalled();
  });

  test('Should reject illegal direct transitions (CREATED -> CAPTURED)', async () => {
    mockPrisma.$queryRaw = jest.fn().mockResolvedValue([
      {
        id: 'mock-tx-uuid',
        status: TransactionState.CAPTURE_FAILED,
        gateway_name: 'Stripe',
      },
    ]);

    await expect(
      TransactionStateMachine.transition(
        mockPrisma,
        'mock-tx-uuid',
        TransactionState.AUTHORISED,
        'test_actor',
        'Illegal jump check',
        null,
        'test-trace-id',
      ),
    ).rejects.toThrow(/Illegal state transition/);

    expect(mockPrisma.transaction.update).not.toHaveBeenCalled();
  });

  test('Should resolve compensating transition path for out-of-order updates (CREATED -> CAPTURED)', async () => {
    await expect(
      TransactionStateMachine.transition(
        mockPrisma,
        'mock-tx-uuid',
        TransactionState.CAPTURED,
        'webhook_processor',
        'Webhook arrived early',
        null,
        'test-trace-id',
      ),
    ).resolves.not.toThrow();

    expect(mockPrisma.transaction.update).toHaveBeenCalledTimes(5);
    expect(mockPrisma.transactionStateLog.create).toHaveBeenCalledTimes(5);
  });
});
