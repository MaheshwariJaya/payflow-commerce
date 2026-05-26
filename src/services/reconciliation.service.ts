import { PrismaClient, TransactionState } from '@prisma/client';
import { GatewayFactory } from '../gateways/gateway.factory';
import { TransactionStateMachine } from '../state-machine/transaction-state-machine';
import { logger } from '../utils/logger';

const prisma = new PrismaClient();

export class ReconciliationService {
  /**
   * Reconciles a single transaction by contacting the gateway and verifying status/amount.
   */
  public static async reconcileTransaction(transactionId: string, traceId: string): Promise<void> {
    logger.info('Running reconciliation checks for transaction', { transaction_id: transactionId, trace_id: traceId });

    await prisma.$transaction(async (txPrisma) => {
      const tx = await txPrisma.transaction.findUnique({
        where: { id: transactionId },
        include: { refunds: true },
      });

      if (!tx) {
        throw new Error(`Transaction with ID ${transactionId} not found.`);
      }

      if (!tx.gateway_name || !tx.gateway_reference_id) {
        // Unrouted or failed transactions don't have gateway reference, reconcile as unrouted fail if in CREATED/ROUTE_SELECTED
        if (tx.status === TransactionState.CREATED || tx.status === TransactionState.ROUTE_SELECTED) {
          await txPrisma.reconciliationLog.create({
            data: {
              transaction_id: transactionId,
              gateway: 'SYSTEM',
              amount_paise: tx.amount_paise,
              status: 'RECONCILED',
              details: 'Unrouted transaction reconciled as failed/abandoned',
              trace_id: traceId,
            },
          });

          await TransactionStateMachine.transition(
            txPrisma,
            transactionId,
            TransactionState.FAILED,
            'reconciliation_engine',
            'Abandoned payment auto-failed by reconciliation checks',
            null,
            traceId
          );
        }
        return;
      }

      const gatewayName = tx.gateway_name;
      const refId = tx.gateway_reference_id;

      // Mock Gateway call to fetch transaction details (mimics querying gateway report log)
      // In production, this would make an API call using the gateway adapter.
      // Here, we simulate that the gateway matches our database unless the metadata has a simulated discrepancy
      const gwStatus = tx.status === TransactionState.FAILED ? 'FAILED' : 'CAPTURED';
      const gwAmount = tx.amount_paise; // default matches

      // Parse metadata for simulation triggers
      const metadata = (tx.metadata as any) || {};
      const simDiscrepancyStatus = metadata.sim_recon_status_discrepancy;
      const simDiscrepancyAmount = metadata.sim_recon_amount_discrepancy;

      const actualGwStatus = simDiscrepancyStatus ? 'FAILED' : gwStatus;
      const actualGwAmount = simDiscrepancyAmount ? gwAmount / BigInt(2) : gwAmount;

      // 1. Verify Amount
      if (actualGwAmount !== tx.amount_paise) {
        logger.error('Reconciliation Anomaly: Amount Discrepancy Detected', {
          transaction_id: transactionId,
          internal_amount: tx.amount_paise.toString(),
          gateway_amount: actualGwAmount.toString(),
        });

        await txPrisma.reconciliationAnomaly.create({
          data: {
            transaction_id: transactionId,
            gateway: gatewayName,
            internal_state: tx.status,
            gateway_state: actualGwStatus,
            severity: 'HIGH',
            notes: `Amount mismatch: Internal=${tx.amount_paise.toString()} paise, Gateway=${actualGwAmount.toString()} paise`,
          },
        });

        await txPrisma.reconciliationLog.create({
          data: {
            transaction_id: transactionId,
            gateway_transaction_id: refId,
            gateway: gatewayName,
            amount_paise: actualGwAmount,
            status: 'DISCREPANCY_AMOUNT',
            details: 'Amount mismatch with gateway',
            trace_id: traceId,
          },
        });
        return;
      }

      // 2. Verify Status
      if (actualGwStatus === 'FAILED' && tx.status === TransactionState.CAPTURED) {
        logger.error('Reconciliation Anomaly: Status Discrepancy Detected', {
          transaction_id: transactionId,
          internal_state: tx.status,
          gateway_state: actualGwStatus,
        });

        await txPrisma.reconciliationAnomaly.create({
          data: {
            transaction_id: transactionId,
            gateway: gatewayName,
            internal_state: tx.status,
            gateway_state: actualGwStatus,
            severity: 'MEDIUM',
            notes: 'Status mismatch: Internal is CAPTURED, but gateway reports FAILED',
          },
        });

        await txPrisma.reconciliationLog.create({
          data: {
            transaction_id: transactionId,
            gateway_transaction_id: refId,
            gateway: gatewayName,
            amount_paise: actualGwAmount,
            status: 'DISCREPANCY_STATUS',
            details: 'Status mismatch with gateway',
            trace_id: traceId,
          },
        });
        return;
      }

      // 3. Reconciled Successfully: Transition from CAPTURED -> SETTLED
      await txPrisma.reconciliationLog.create({
        data: {
          transaction_id: transactionId,
          gateway_transaction_id: refId,
          gateway: gatewayName,
          amount_paise: actualGwAmount,
          status: 'RECONCILED',
          details: 'Successfully verified and settled.',
          trace_id: traceId,
        },
      });

      if (tx.status === TransactionState.CAPTURED || tx.status === TransactionState.REFUNDED) {
        await TransactionStateMachine.transition(
          txPrisma,
          transactionId,
          TransactionState.SETTLED,
          'reconciliation_engine',
          'Transaction settled by reconciliation run',
          null,
          traceId
        );
      }
    });
  }

  /**
   * Queries unresolved/unreconciled payments and schedules them in the queue.
   */
  public static async triggerBulkReconciliation(traceId: string): Promise<number> {
    // Find all transactions that are not in terminal SETTLED, FAILED, VOIDED states, older than 1 minute
    const oneMinuteAgo = new Date(Date.now() - 60000);
    const transactions = await prisma.transaction.findMany({
      where: {
        status: {
          in: [
            TransactionState.CAPTURED,
            TransactionState.REFUNDED,
            TransactionState.CREATED,
            TransactionState.ROUTE_SELECTED,
          ],
        },
        created_at: { lt: oneMinuteAgo },
      },
    });

    const QueueService = await import('../queue/queue.service');
    for (const tx of transactions) {
      await QueueService.QueueService.enqueueReconciliation(tx.id, traceId);
    }

    return transactions.length;
  }
}
