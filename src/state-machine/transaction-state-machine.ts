import { TransactionState } from '@prisma/client';
import { logger } from '../utils/logger';
import { EventEmitter } from 'events';

export const domainEvents = new EventEmitter();

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

  [TransactionState.VOIDED]: new Set(),
  [TransactionState.AUTH_EXPIRED]: new Set(),
  [TransactionState.SETTLED]: new Set(),
  [TransactionState.FAILED]: new Set(),
};

const COMPENSATING_PATHS: Record<string, TransactionState[]> = {
  [`${TransactionState.CREATED}->${TransactionState.CAPTURED}`]: [
    TransactionState.ROUTE_SELECTED,
    TransactionState.AUTH_INITIATED,
    TransactionState.AUTHORISED,
    TransactionState.CAPTURE_INITIATED,
    TransactionState.CAPTURED,
  ],

  [`${TransactionState.ROUTE_SELECTED}->${TransactionState.CAPTURED}`]: [
    TransactionState.AUTH_INITIATED,
    TransactionState.AUTHORISED,
    TransactionState.CAPTURE_INITIATED,
    TransactionState.CAPTURED,
  ],

  [`${TransactionState.AUTH_INITIATED}->${TransactionState.CAPTURED}`]: [
    TransactionState.AUTHORISED,
    TransactionState.CAPTURE_INITIATED,
    TransactionState.CAPTURED,
  ],

  [`${TransactionState.AUTHORISED}->${TransactionState.CAPTURED}`]: [
    TransactionState.CAPTURE_INITIATED,
    TransactionState.CAPTURED,
  ],

  [`${TransactionState.CREATED}->${TransactionState.AUTHORISED}`]: [
    TransactionState.ROUTE_SELECTED,
    TransactionState.AUTH_INITIATED,
    TransactionState.AUTHORISED,
  ],

  [`${TransactionState.ROUTE_SELECTED}->${TransactionState.AUTHORISED}`]: [
    TransactionState.AUTH_INITIATED,
    TransactionState.AUTHORISED,
  ],
};

export class TransactionStateMachine {
  public static async transition(
    prisma: any,
    transactionId: string,
    targetState: TransactionState,
    actor: string,
    reason: string | null = null,
    metadata: Record<string, any> | null = null,
    traceId: string,
  ): Promise<any> {
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
        traceId,
      );
      return;
    }

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
          traceId,
        );
        lastState = nextState;
      }
      return;
    }

    const errorMsg = `Illegal state transition: Cannot transition from ${currentState} to ${targetState}`;
    logger.error(errorMsg, {
      transaction_id: transactionId,
      currentState,
      targetState,
      trace_id: traceId,
    });
    throw new Error(errorMsg);
  }

  private static async executeSingleTransition(
    prisma: any,
    transactionId: string,
    fromState: TransactionState,
    toState: TransactionState,
    gateway: string | null,
    actor: string,
    reason: string | null,
    metadata: Record<string, any> | null,
    traceId: string,
  ): Promise<void> {
    await prisma.transaction.update({
      where: { id: transactionId },
      data: { status: toState },
    });

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
