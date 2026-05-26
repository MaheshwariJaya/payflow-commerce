import { TransactionState, PrismaClient } from '@prisma/client';
import { logger } from '../utils/logger';
import { EventEmitter } from 'events';

// Local Domain Event Emitter
export const domainEvents = new EventEmitter();

// Allowed direct transitions
const VALID_TRANSITIONS: Record<TransactionState, Set<TransactionState>> = {
  [TransactionState.CREATED]: new Set([TransactionState.ROUTE_SELECTED, TransactionState.FAILED]),
  [TransactionState.ROUTE_SELECTED]: new Set([
    TransactionState.ROUTE_SELECTED,
    TransactionState.AUTH_INITIATED,
    TransactionState.AUTH_FAILED,
    TransactionState.FAILED,
  ]),
  [TransactionState.AUTH_INITIATED]: new Set([
    TransactionState.AUTHORISED,
    TransactionState.AUTH_FAILED,
    TransactionState.FAILED,
  ]),
  [TransactionState.AUTHORISED]: new Set([
    TransactionState.CAPTURE_INITIATED,
    TransactionState.VOID_INITIATED,
    TransactionState.AUTH_EXPIRED,
  ]),
  [TransactionState.AUTH_FAILED]: new Set([TransactionState.FAILED]),
  [TransactionState.CAPTURE_INITIATED]: new Set([
    TransactionState.CAPTURED,
    TransactionState.PARTIALLY_CAPTURED,
    TransactionState.CAPTURE_FAILED,
  ]),
  [TransactionState.CAPTURED]: new Set([TransactionState.REFUND_INITIATED, TransactionState.SETTLED]),
  [TransactionState.PARTIALLY_CAPTURED]: new Set([TransactionState.REFUND_INITIATED, TransactionState.SETTLED]),
  [TransactionState.CAPTURE_FAILED]: new Set([TransactionState.FAILED]),
  [TransactionState.REFUND_INITIATED]: new Set([
    TransactionState.REFUNDED,
    TransactionState.PARTIALLY_REFUNDED,
    TransactionState.REFUND_FAILED,
  ]),
  [TransactionState.REFUNDED]: new Set([TransactionState.SETTLED]),
  [TransactionState.PARTIALLY_REFUNDED]: new Set([TransactionState.REFUND_INITIATED, TransactionState.SETTLED]),
  [TransactionState.REFUND_FAILED]: new Set([TransactionState.REFUND_INITIATED]),
  [TransactionState.VOID_INITIATED]: new Set([TransactionState.VOIDED, TransactionState.FAILED]),

  // Terminal States
  [TransactionState.VOIDED]: new Set(),
  [TransactionState.AUTH_EXPIRED]: new Set(),
  [TransactionState.SETTLED]: new Set(),
  [TransactionState.FAILED]: new Set(),
};

// Hardcoded path resolution for out-of-order state transitions (compensating state flows)
const COMPENSATING_PATHS: Record<string, TransactionState[]> = {
  // From CREATED to CAPTURED
  [`${TransactionState.CREATED}->${TransactionState.CAPTURED}`]: [
    TransactionState.ROUTE_SELECTED,
    TransactionState.AUTH_INITIATED,
    TransactionState.AUTHORISED,
    TransactionState.CAPTURE_INITIATED,
    TransactionState.CAPTURED,
  ],
  // From ROUTE_SELECTED to CAPTURED
  [`${TransactionState.ROUTE_SELECTED}->${TransactionState.CAPTURED}`]: [
    TransactionState.AUTH_INITIATED,
    TransactionState.AUTHORISED,
    TransactionState.CAPTURE_INITIATED,
    TransactionState.CAPTURED,
  ],
  // From AUTH_INITIATED to CAPTURED
  [`${TransactionState.AUTH_INITIATED}->${TransactionState.CAPTURED}`]: [
    TransactionState.AUTHORISED,
    TransactionState.CAPTURE_INITIATED,
    TransactionState.CAPTURED,
  ],
  // From AUTHORISED to CAPTURED
  [`${TransactionState.AUTHORISED}->${TransactionState.CAPTURED}`]: [
    TransactionState.CAPTURE_INITIATED,
    TransactionState.CAPTURED,
  ],
  // From CREATED to AUTHORISED
  [`${TransactionState.CREATED}->${TransactionState.AUTHORISED}`]: [
    TransactionState.ROUTE_SELECTED,
    TransactionState.AUTH_INITIATED,
    TransactionState.AUTHORISED,
  ],
  // From ROUTE_SELECTED to AUTHORISED
  [`${TransactionState.ROUTE_SELECTED}->${TransactionState.AUTHORISED}`]: [
    TransactionState.AUTH_INITIATED,
    TransactionState.AUTHORISED,
  ],
};

export class TransactionStateMachine {
  /**
   * Validates and executes a state transition inside a database transaction.
   * If the transition is out-of-order, it expands it to run all intermediate transitions.
   */
  public static async transition(
    prisma: any,
    transactionId: string,
    targetState: TransactionState,
    actor: string,
    reason: string | null = null,
    metadata: Record<string, any> | null = null,
    traceId: string
  ): Promise<any> {
    // Acquire a row-level lock on the transaction to prevent concurrent status modification
    const transaction = await prisma.$queryRaw`
      SELECT id, status, "gateway_name" FROM "Transaction" WHERE id = ${transactionId}::uuid FOR UPDATE
    `;

    if (!transaction || transaction.length === 0) {
      throw new Error(`Transaction with ID ${transactionId} not found.`);
    }

    const currentTx = transaction[0];
    const currentState = currentTx.status as TransactionState;
    const gateway = currentTx.gateway_name;

    if (currentState === targetState) {
      if (targetState !== TransactionState.ROUTE_SELECTED) {
        logger.info('Transaction is already in the target state. No-op.', {
          transaction_id: transactionId,
          currentState,
          targetState,
          trace_id: traceId,
        });
        return;
      }
    }

    // 1. Direct Transition Check
    if (VALID_TRANSITIONS[currentState].has(targetState)) {
      await this.executeSingleTransition(
        prisma,
        transactionId,
        currentState,
        targetState,
        gateway,
        actor,
        reason,
        metadata,
        traceId
      );
      return;
    }

    // 2. Compensating Transition Path Resolution (Out-of-order hook handler)
    const pathKey = `${currentState}->${targetState}`;
    const path = COMPENSATING_PATHS[pathKey];

    if (path) {
      logger.warn(`Resolving out-of-order state transition. Generating compensating path.`, {
        transaction_id: transactionId,
        pathKey,
        path,
        trace_id: traceId,
      });

      let lastState = currentState;
      for (const nextState of path) {
        await this.executeSingleTransition(
          prisma,
          transactionId,
          lastState,
          nextState,
          gateway,
          actor,
          nextState === targetState ? reason : 'Compensating path transition for out-of-order updates',
          nextState === targetState ? metadata : null,
          traceId
        );
        lastState = nextState;
      }
      return;
    }

    // 3. Fallback: Illegal transition
    const errorMsg = `Illegal state transition: Cannot transition from ${currentState} to ${targetState}`;
    logger.error(errorMsg, {
      transaction_id: transactionId,
      currentState,
      targetState,
      trace_id: traceId,
    });
    throw new Error(errorMsg);
  }

  /**
   * Helper to execute a single atomic state transition in the DB.
   */
  private static async executeSingleTransition(
    prisma: any,
    transactionId: string,
    fromState: TransactionState,
    toState: TransactionState,
    gateway: string | null,
    actor: string,
    reason: string | null,
    metadata: Record<string, any> | null,
    traceId: string
  ): Promise<void> {
    // Write state update
    await prisma.transaction.update({
      where: { id: transactionId },
      data: { status: toState },
    });

    // Write immutable audit log
    await prisma.transactionStateLog.create({
      data: {
        transaction_id: transactionId,
        from_state: fromState,
        to_state: toState,
        gateway: gateway,
        reason: reason,
        metadata: metadata || undefined,
        created_by: actor,
        trace_id: traceId,
      },
    });

    logger.info(`State transition successful: ${fromState} -> ${toState}`, {
      transaction_id: transactionId,
      from_state: fromState,
      to_state: toState,
      gateway,
      actor,
      trace_id: traceId,
    });

    // Emit domain event asynchronously (allows decoupled triggers like metrics reporting/recon)
    domainEvents.emit(toState, {
      transactionId,
      fromState,
      toState,
      gateway,
      actor,
      traceId,
    });
  }
}
