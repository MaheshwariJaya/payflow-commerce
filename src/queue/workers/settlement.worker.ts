import { Worker, Job } from 'bullmq';
import { PrismaClient, TransactionState } from '@prisma/client';
import { redis } from '../../config/redis';
import { TransactionStateMachine } from '../../state-machine/transaction-state-machine';
import { logger, traceStore } from '../../utils/logger';
import * as crypto from 'crypto';

const prisma = new PrismaClient();

export const settlementWorker = new Worker(
  'settlement-queue',
  async (job: Job) => {
    const { transactionId, traceId } = job.data;

    const store = new Map<string, string>();
    store.set('trace_id', traceId);
    store.set('transaction_id', transactionId);
    store.set('action', 'settlement_worker');

    return traceStore.run(store, async () => {
      logger.info(`Settlement worker processing transaction: ${transactionId}`);

      try {
        const tx = await prisma.transaction.findUnique({
          where: { id: transactionId },
        });

        if (!tx) {
          throw new Error(`Transaction ${transactionId} not found.`);
        }

        if (tx.status !== TransactionState.CAPTURED && tx.status !== TransactionState.SETTLED) {
          logger.warn(`Transaction is in state ${tx.status}, skipping settlement processing.`);
          return;
        }

        // Check if settlement record already exists
        const existing = await prisma.settlement.findFirst({
          where: { transaction_id: transactionId },
        });

        if (existing) {
          logger.info(`Settlement already processed for transaction: ${transactionId}`);
          return;
        }

        // Simulate settlement reference ID generation
        const settlementRef = `set_${crypto.randomBytes(8).toString('hex')}`;
        
        await prisma.$transaction(async (txPrisma) => {
          // Create Settlement Record
          await txPrisma.settlement.create({
            data: {
              transaction_id: transactionId,
              gateway: tx.gateway_name || 'SYSTEM',
              settlement_reference: settlementRef,
              amount_paise: tx.amount_paise,
              settlement_date: new Date(),
              status: 'SETTLED',
            },
          });

          // Transition state to SETTLED if not already terminal
          if (tx.status === TransactionState.CAPTURED) {
            await TransactionStateMachine.transition(
              txPrisma,
              transactionId,
              TransactionState.SETTLED,
              'settlement_worker',
              `Settlement reference registered: ${settlementRef}`,
              null,
              traceId
            );
          }
        });

        logger.info(`Successfully completed settlement execution`, {
          settlement_reference: settlementRef,
          transaction_id: transactionId,
        });
      } catch (err: any) {
        logger.error(`Settlement worker failed`, { error: err.message });
        throw err;
      }
    });
  },
  { connection: redis }
);
