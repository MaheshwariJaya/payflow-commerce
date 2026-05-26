import { PrismaClient, TransactionState, Transaction, Refund } from '@prisma/client';
import { TransactionStateMachine } from '../state-machine/transaction-state-machine';
import { RoutingEngine } from '../routing-engine/routing-engine';
import { GatewayFactory } from '../gateways/gateway.factory';
import { GatewayRateLimiter } from '../middleware/rate-limiter';
import { CircuitBreakerManager } from '../gateways/circuit-breaker.manager';
import { withTimeout } from '../utils/timeout.util';
import { QueueService } from '../queue/queue.service';
import { logger, setLogContext } from '../utils/logger';


const prisma = new PrismaClient();

export class PaymentService {
  /**
   * Initiates payment routing, failover, rate-limiting, and circuit checking.
   */
  public static async createPayment(
    amountPaise: bigint,
    currency: string,
    paymentMethod: string,
    customerId: string,
    merchantOrderId: string,
    idempotencyKey: string,
    metadata: any,
    traceId: string
  ): Promise<Transaction> {
    logger.info('Initializing payment request', {
      amountPaise: amountPaise.toString(),
      currency,
      paymentMethod,
      merchantOrderId,
      trace_id: traceId,
    });

    // 1. Save baseline CREATED transaction
    const tx = await prisma.$transaction(async (txPrisma) => {
      const createdTx = await txPrisma.transaction.create({
        data: {
          merchant_order_id: merchantOrderId,
          amount_paise: amountPaise,
          currency: currency.toUpperCase(),
          status: TransactionState.CREATED,
          payment_method: paymentMethod.toUpperCase(),
          customer_id: customerId,
          idempotency_key: idempotencyKey,
          trace_id: traceId,
          metadata: metadata || undefined,
        },
      });

      // Record first state audit log
      await txPrisma.transactionStateLog.create({
        data: {
          transaction_id: createdTx.id,
          from_state: TransactionState.CREATED,
          to_state: TransactionState.CREATED,
          reason: 'Initial creation',
          created_by: 'payment_service',
          trace_id: traceId,
        },
      });

      return createdTx;
    });

    setLogContext('transaction_id', tx.id);

    // 2. Query routing engine for scored candidates
    let routes;
    try {
      routes = await RoutingEngine.selectRoute(prisma, amountPaise, currency, paymentMethod, traceId);
    } catch (routeErr: any) {
      logger.error('Routing selection failed', { error: routeErr.message });
      await prisma.$transaction(async (txPrisma) => {
        await TransactionStateMachine.transition(
          txPrisma,
          tx.id,
          TransactionState.FAILED,
          'payment_service',
          `Routing failed: ${routeErr.message}`,
          null,
          traceId
        );
      });
      throw routeErr;
    }

    // 3. Failover Loop
    let successfulTx: Transaction | null = null;
    let errors: string[] = [];

    for (const route of routes) {
      const gatewayName = route.gatewayName;
      setLogContext('gateway', gatewayName);

      // Check Rate Limits
      const hasTokens = await GatewayRateLimiter.tryAcquire(gatewayName);
      if (!hasTokens) {
        const msg = `Rate limit exceeded for gateway ${gatewayName}. Skipping...`;
        logger.warn(msg);
        errors.push(msg);
        continue;
      }

      // Check Circuit Breaker State
      const isAvailable = await CircuitBreakerManager.isAvailable(gatewayName, paymentMethod, prisma, traceId);
      if (!isAvailable) {
        const msg = `Circuit breaker is OPEN/Tripped for gateway ${gatewayName} - ${paymentMethod}. Skipping...`;
        logger.warn(msg);
        errors.push(msg);
        continue;
      }

      // Try processing payment through this gateway
      try {
        logger.info(`Attempting payment routing through ${gatewayName}`, {
          gateway: gatewayName,
          score: route.score,
        });

        // Update state to ROUTE_SELECTED
        await prisma.$transaction(async (txPrisma) => {
          await txPrisma.transaction.update({
            where: { id: tx.id },
            data: { gateway_name: gatewayName, attempts: { increment: 1 } },
          });

          await TransactionStateMachine.transition(
            txPrisma,
            tx.id,
            TransactionState.ROUTE_SELECTED,
            'payment_service',
            `Selected gateway: ${gatewayName}`,
            { score: route.score },
            traceId
          );
        });

        // Initialize adapter
        const adapter = GatewayFactory.getAdapter(gatewayName);
        const startTime = Date.now();

        // Wrap execution in 2-second timeout
        const gatewayResponse = await withTimeout(
          async () =>
            adapter.initializePayment(
              tx.id,
              amountPaise,
              currency,
              paymentMethod,
              merchantOrderId,
              metadata,
              traceId
            ),
          2000,
          `Gateway: ${gatewayName} initialize`
        );

        const latency = Date.now() - startTime;

        if (gatewayResponse.success && gatewayResponse.gatewayReferenceId) {
          // Success: Update circuit and status
          await CircuitBreakerManager.recordSuccess(gatewayName, paymentMethod, latency, prisma, traceId);

          successfulTx = await prisma.$transaction(async (txPrisma) => {
            const updated = await txPrisma.transaction.update({
              where: { id: tx.id },
              data: {
                gateway_reference_id: gatewayResponse.gatewayReferenceId,
              },
            });

            const nextState =
              gatewayResponse.status === 'captured'
                ? TransactionState.CAPTURED
                : TransactionState.AUTH_INITIATED;

            await TransactionStateMachine.transition(
              txPrisma,
              tx.id,
              nextState,
              'payment_service',
              `Gateway success reference: ${gatewayResponse.gatewayReferenceId}`,
              { raw: gatewayResponse.rawResponse },
              traceId
            );

            return updated;
          });

          logger.info(`Successfully completed payment request via ${gatewayName}`, {
            transaction_id: tx.id,
            latency_ms: latency,
          });

          // Enqueue async tasks like settlements if payment is captured immediately
          if (gatewayResponse.status === 'captured') {
            await QueueService.enqueueSettlement(tx.id, traceId);
          }

          break; // Exit loop on success
        } else {
          // Failed Gateway Response (e.g. Card Declined)
          const errorMsg = gatewayResponse.error || 'Gateway returned failure status';
          logger.warn(`Gateway payment execution failed`, { gateway: gatewayName, error: errorMsg });
          errors.push(`${gatewayName} failed: ${errorMsg}`);

          await CircuitBreakerManager.recordFailure(gatewayName, paymentMethod, errorMsg, prisma, traceId);
        }
      } catch (err: any) {
        // Network Timeout or connection errors
        const errorMsg = err.message || 'Unknown network error';
        logger.error(`Gateway request connection exception`, { gateway: gatewayName, error: errorMsg });
        errors.push(`${gatewayName} error: ${errorMsg}`);

        await CircuitBreakerManager.recordFailure(gatewayName, paymentMethod, errorMsg, prisma, traceId);
      }
    }

    if (successfulTx) {
      return successfulTx;
    }

    // 4. All gateways failed: Fail the transaction
    const finalErrorMsg = `All routing pathways failed. Errors: ${errors.join(' | ')}`;
    logger.error(finalErrorMsg, { transaction_id: tx.id });

    return await prisma.$transaction(async (txPrisma) => {
      const failedTx = await txPrisma.transaction.update({
        where: { id: tx.id },
        data: {
          last_error: finalErrorMsg.substring(0, 1000),
        },
      });

      await TransactionStateMachine.transition(
        txPrisma,
        tx.id,
        TransactionState.FAILED,
        'payment_service',
        'Routing failover exhausted all active pathways',
        { errors },
        traceId
      );

      return failedTx;
    });
  }

  /**
   * Captures an authorized payment.
   */
  public static async capturePayment(
    transactionId: string,
    amountPaise: bigint,
    traceId: string
  ): Promise<Transaction> {
    setLogContext('transaction_id', transactionId);
    
    return await prisma.$transaction(async (txPrisma) => {
      const tx = await txPrisma.transaction.findUnique({
        where: { id: transactionId },
      });

      if (!tx) {
        throw new Error('Transaction not found');
      }

      if (tx.status !== TransactionState.AUTHORISED) {
        throw new Error(`Cannot capture transaction in status: ${tx.status}. Must be AUTHORISED.`);
      }

      if (!tx.gateway_name || !tx.gateway_reference_id) {
        throw new Error('Transaction is missing routing reference metadata required for capture.');
      }

      setLogContext('gateway', tx.gateway_name);

      // Transition to CAPTURE_INITIATED
      await TransactionStateMachine.transition(
        txPrisma,
        transactionId,
        TransactionState.CAPTURE_INITIATED,
        'payment_service',
        'Initiating capture request',
        null,
        traceId
      );

      const adapter = GatewayFactory.getAdapter(tx.gateway_name);

      try {
        const response = await adapter.capturePayment(
          transactionId,
          tx.gateway_reference_id,
          amountPaise,
          traceId
        );

        if (response.success) {
          const finalState =
            amountPaise < tx.amount_paise
              ? TransactionState.PARTIALLY_CAPTURED
              : TransactionState.CAPTURED;

          const updated = await txPrisma.transaction.update({
            where: { id: transactionId },
            data: { status: finalState },
          });

          await TransactionStateMachine.transition(
            txPrisma,
            transactionId,
            finalState,
            'payment_service',
            `Capture success. Amount captured: ${amountPaise.toString()} paise`,
            response.rawResponse,
            traceId
          );

          // Enqueue settlement background processing
          await QueueService.enqueueSettlement(transactionId, traceId);

          return updated;
        } else {
          throw new Error(response.error || 'Gateway capture rejected');
        }
      } catch (err: any) {
        logger.error('Capture operation failed', { error: err.message });

        await TransactionStateMachine.transition(
          txPrisma,
          transactionId,
          TransactionState.CAPTURE_FAILED,
          'payment_service',
          `Capture failed: ${err.message}`,
          null,
          traceId
        );

        throw err;
      }
    });
  }

  /**
   * Fully or partially refunds a captured/settled transaction.
   */
  public static async refundPayment(
    transactionId: string,
    amountPaise: bigint,
    reason: string,
    traceId: string
  ): Promise<Refund> {
    setLogContext('transaction_id', transactionId);

    return await prisma.$transaction(async (txPrisma) => {
      const tx = await txPrisma.transaction.findUnique({
        where: { id: transactionId },
        include: { refunds: true },
      });

      if (!tx) {
        throw new Error('Transaction not found');
      }

      if (tx.status !== TransactionState.CAPTURED && tx.status !== TransactionState.SETTLED && tx.status !== TransactionState.PARTIALLY_REFUNDED) {
        throw new Error(`Cannot refund transaction in status: ${tx.status}. Must be CAPTURED, SETTLED, or PARTIALLY_REFUNDED.`);
      }

      if (!tx.gateway_name || !tx.gateway_reference_id) {
        throw new Error('Missing gateway references required for refund execution');
      }

      setLogContext('gateway', tx.gateway_name);

      // Verify refund limits
      const totalRefunded = tx.refunds
        .filter((r) => r.status === 'REFUNDED')
        .reduce((sum, r) => sum + r.amount_paise, BigInt(0));

      const remainingBalance = tx.amount_paise - totalRefunded;

      if (amountPaise > remainingBalance) {
        throw new Error(`Refund amount ${amountPaise.toString()} paise exceeds available balance of ${remainingBalance.toString()} paise.`);
      }

      // Create PENDING refund log
      const refund = await txPrisma.refund.create({
        data: {
          transaction_id: transactionId,
          amount_paise: amountPaise,
          status: 'REFUND_INITIATED',
          reason,
        },
      });

      // Transition transaction state
      await TransactionStateMachine.transition(
        txPrisma,
        transactionId,
        TransactionState.REFUND_INITIATED,
        'payment_service',
        `Initiating refund of ${amountPaise.toString()} paise`,
        { refund_id: refund.id },
        traceId
      );

      const adapter = GatewayFactory.getAdapter(tx.gateway_name);

      try {
        const response = await adapter.refundPayment(
          transactionId,
          tx.gateway_reference_id,
          amountPaise,
          traceId
        );

        if (response.success && response.gatewayReferenceId) {
          const updatedRefund = await txPrisma.refund.update({
            where: { id: refund.id },
            data: {
              status: 'REFUNDED',
              gateway_refund_id: response.gatewayReferenceId,
            },
          });

          // Check if fully or partially refunded
          const newTotalRefunded = totalRefunded + amountPaise;
          const finalState =
            newTotalRefunded >= tx.amount_paise
              ? TransactionState.REFUNDED
              : TransactionState.PARTIALLY_REFUNDED;

          await TransactionStateMachine.transition(
            txPrisma,
            transactionId,
            finalState,
            'payment_service',
            `Refund executed successfully. Reference: ${response.gatewayReferenceId}`,
            response.rawResponse,
            traceId
          );

          return updatedRefund;
        } else {
          throw new Error(response.error || 'Gateway refund rejected');
        }
      } catch (err: any) {
        logger.error('Refund execution failed', { error: err.message });

        await txPrisma.refund.update({
          where: { id: refund.id },
          data: { status: 'REFUND_FAILED' },
        });

        await TransactionStateMachine.transition(
          txPrisma,
          transactionId,
          TransactionState.REFUND_FAILED,
          'payment_service',
          `Refund failed: ${err.message}`,
          null,
          traceId
        );

        throw err;
      }
    });
  }

  /**
   * Voids an authorized, uncaptured payment.
   */
  public static async voidPayment(
    transactionId: string,
    traceId: string
  ): Promise<Transaction> {
    setLogContext('transaction_id', transactionId);

    return await prisma.$transaction(async (txPrisma) => {
      const tx = await txPrisma.transaction.findUnique({
        where: { id: transactionId },
      });

      if (!tx) {
        throw new Error('Transaction not found');
      }

      if (tx.status !== TransactionState.AUTHORISED) {
        throw new Error(`Cannot void transaction in status: ${tx.status}. Must be AUTHORISED.`);
      }

      if (!tx.gateway_name || !tx.gateway_reference_id) {
        throw new Error('Missing gateway references required for void execution');
      }

      setLogContext('gateway', tx.gateway_name);

      await TransactionStateMachine.transition(
        txPrisma,
        transactionId,
        TransactionState.VOID_INITIATED,
        'payment_service',
        'Initiating void authorization',
        null,
        traceId
      );

      const adapter = GatewayFactory.getAdapter(tx.gateway_name);

      try {
        const response = await adapter.voidPayment(
          transactionId,
          tx.gateway_reference_id,
          traceId
        );

        if (response.success) {
          const updated = await txPrisma.transaction.update({
            where: { id: transactionId },
            data: { status: TransactionState.VOIDED },
          });

          await TransactionStateMachine.transition(
            txPrisma,
            transactionId,
            TransactionState.VOIDED,
            'payment_service',
            'Void execution completed',
            response.rawResponse,
            traceId
          );

          return updated;
        } else {
          throw new Error(response.error || 'Gateway void authorization rejected');
        }
      } catch (err: any) {
        logger.error('Void authorization failed', { error: err.message });

        await TransactionStateMachine.transition(
          txPrisma,
          transactionId,
          TransactionState.FAILED,
          'payment_service',
          `Void execution failed: ${err.message}`,
          null,
          traceId
        );

        throw err;
      }
    });
  }
}
