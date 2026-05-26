export interface GatewayResponse {
  success: boolean;
  gatewayReferenceId?: string;
  error?: string;
  status: 'authorised' | 'captured' | 'failed' | 'refunded' | 'voided';
  rawResponse: any;
}

export interface ParsedWebhookEvent {
  eventId: string;
  transactionId: string;
  status: 'authorised' | 'captured' | 'failed' | 'refunded' | 'voided';
  amountPaise: bigint;
  gatewayReferenceId: string;
  rawPayload: any;
}

export interface IGatewayAdapter {
  name: string;
  
  initializePayment(
    transactionId: string,
    amountPaise: bigint,
    currency: string,
    paymentMethod: string,
    merchantOrderId: string,
    metadata: any,
    traceId: string
  ): Promise<GatewayResponse>;

  capturePayment(
    transactionId: string,
    gatewayRefId: string,
    amountPaise: bigint,
    traceId: string
  ): Promise<GatewayResponse>;

  refundPayment(
    transactionId: string,
    gatewayRefId: string,
    amountPaise: bigint,
    traceId: string
  ): Promise<GatewayResponse>;

  voidPayment(
    transactionId: string,
    gatewayRefId: string,
    traceId: string
  ): Promise<GatewayResponse>;

  verifyWebhookSignature(
    headers: Record<string, string>,
    rawBody: string,
    secret: string
  ): boolean;

  parseWebhookEvent(body: any): ParsedWebhookEvent;
}
