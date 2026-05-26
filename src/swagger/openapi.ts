export const openapiSpec = {
  openapi: '3.0.0',
  info: {
    title: 'PayFlow Commerce - Payment Orchestration Layer API',
    version: '1.0.0',
    description:
      'Production-grade Payment Orchestration API supporting multi-gateway failover, circuit breakers, dynamic routing, webhooks deduplication, and reconciliation checks.',
  },
  servers: [
    {
      url: 'http://localhost:3000',
      description: 'Local Development Server',
    },
  ],
  security: [
    {
      BearerAuth: [],
    },
    {
      ApiKeyAuth: [],
    },
  ],
  paths: {
    '/api/v1/auth/token': {
      post: {
        summary: 'Generate Test JWT Auth Token',
        description: 'Utility endpoint to generate a Bearer JWT token for testing other endpoints.',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['customer_id'],
                properties: {
                  customer_id: {
                    type: 'string',
                    example: 'cust_98765',
                  },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Token generated successfully.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    access_token: { type: 'string' },
                    token_type: { type: 'string' },
                    expires_in: { type: 'integer' },
                  },
                },
              },
            },
          },
          400: {
            description: 'Bad Request. Missing customer_id.',
          },
        },
      },
    },
    '/api/v1/payments': {
      post: {
        summary: 'Initiate a Payment Request',
        description:
          'Intelligently routes a payment through active gateways based on scoring weights and priority matrix. Evaluates rate limits and circuit breaker status dynamically.',
        security: [{ BearerAuth: [] }],
        parameters: [
          {
            name: 'Idempotency-Key',
            in: 'header',
            required: true,
            schema: { type: 'string' },
            description: 'Unique key to identify the transaction request and prevent double-charging.',
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['amount_paise', 'currency', 'payment_method', 'customer_id', 'merchant_order_id'],
                properties: {
                  amount_paise: {
                    type: 'integer',
                    format: 'int64',
                    example: 50000,
                    description: 'Amount in smallest currency unit (e.g. 50000 paise = 500 INR).',
                  },
                  currency: {
                    type: 'string',
                    maxLength: 3,
                    example: 'INR',
                  },
                  payment_method: {
                    type: 'string',
                    enum: ['CARD', 'UPI', 'NETBANKING'],
                    example: 'CARD',
                  },
                  customer_id: {
                    type: 'string',
                    example: 'cust_98765',
                  },
                  merchant_order_id: {
                    type: 'string',
                    example: 'order_abc123_sim_success',
                    description: 'Your order ID. Pass sim_timeout, sim_500, or sim_failure to test failover scenarios.',
                  },
                  metadata: {
                    type: 'object',
                    example: { user_email: 'customer@email.com' },
                  },
                },
              },
            },
          },
        },
        responses: {
          201: {
            description: 'Payment Created or Authorized successfully.',
          },
          400: {
            description: 'Bad Request. Missing parameters or signature mismatches.',
          },
          409: {
            description: 'Conflict. Idempotency key already processing or concurrent submit.',
          },
          429: { description: 'Too Many Requests. Rate limits exceeded.' },
          500: {
            description: 'Internal Server Error. Exhausted failover options.',
          },
        },
      },
    },
    '/api/v1/payments/{id}': {
      get: {
        summary: 'Get Payment Details',
        security: [{ BearerAuth: [] }],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'string', format: 'uuid' },
          },
        ],
        responses: {
          200: { description: 'Returns transaction details.' },
          404: { description: 'Transaction not found.' },
        },
      },
    },
    '/api/v1/payments/{id}/capture': {
      post: {
        summary: 'Capture an Authorized Payment',
        security: [{ BearerAuth: [] }],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'string', format: 'uuid' },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['amount_paise'],
                properties: {
                  amount_paise: { type: 'integer', example: 50000 },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Captured successfully.' },
        },
      },
    },
    '/api/v1/payments/{id}/refund': {
      post: {
        summary: 'Refund a Captured Payment',
        security: [{ BearerAuth: [] }],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'string', format: 'uuid' },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['amount_paise', 'reason'],
                properties: {
                  amount_paise: { type: 'integer', example: 25000 },
                  reason: {
                    type: 'string',
                    example: 'Customer cancellation request.',
                  },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Refund registered.' },
        },
      },
    },
    '/api/v1/payments/{id}/void': {
      post: {
        summary: 'Void an Authorized Payment',
        security: [{ BearerAuth: [] }],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'string', format: 'uuid' },
          },
        ],
        responses: {
          200: { description: 'Authorization canceled.' },
        },
      },
    },
    '/api/v1/payments/{id}/timeline': {
      get: {
        summary: 'Get Transaction Audit Logs / State Timeline',
        security: [{ BearerAuth: [] }],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'string', format: 'uuid' },
          },
        ],
        responses: {
          200: { description: 'Returns sequential transaction state audits.' },
        },
      },
    },
    '/api/v1/webhooks/{gateway}': {
      post: {
        summary: 'Receive Gateway Webhooks',
        description:
          'Endpoint to accept asynchronous gateway webhooks. Validates signatures and timestamp replay windows, processes composite deduplication, and queues events.',
        parameters: [
          {
            name: 'gateway',
            in: 'path',
            required: true,
            schema: {
              type: 'string',
              enum: ['stripe', 'razorpay', 'payu', 'upi'],
            },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object' },
            },
          },
        },
        responses: {
          200: { description: 'Webhook queued successfully.' },
          400: { description: 'Signature or timestamp validation failed.' },
        },
      },
    },
    '/api/v1/webhooks/replay/{event_id}': {
      post: {
        summary: 'Replay Failed Webhook Event',
        security: [{ ApiKeyAuth: [] }],
        parameters: [
          {
            name: 'event_id',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
        responses: {
          200: { description: 'Replayed and enqueued.' },
        },
      },
    },
    '/api/v1/gateways': {
      get: {
        summary: 'List Gateway Configurations',
        security: [{ ApiKeyAuth: [] }],
        responses: {
          200: { description: 'Sanitized gateway list.' },
        },
      },
    },
    '/api/v1/gateways/{name}/config': {
      put: {
        summary: 'Update Gateway Configuration',
        security: [{ ApiKeyAuth: [] }],
        parameters: [
          {
            name: 'name',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  is_active: { type: 'boolean' },
                  base_url: { type: 'string' },
                  api_key: { type: 'string' },
                  api_secret: { type: 'string' },
                  supported_methods: {
                    type: 'array',
                    items: { type: 'string' },
                  },
                  rate_limit_capacity: { type: 'integer' },
                  rate_limit_refill: { type: 'integer' },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Config updated.' },
        },
      },
    },
    '/api/v1/reconciliation/trigger': {
      post: {
        summary: 'Trigger Bulk Reconciliation run',
        security: [{ ApiKeyAuth: [] }],
        responses: {
          202: {
            description: 'Bulk reconciliation processing started in background worker.',
          },
        },
      },
    },
    '/api/v1/analytics/dashboard': {
      get: {
        summary: 'Get Administrative Dashboard Indicators',
        security: [{ ApiKeyAuth: [] }],
        responses: {
          200: {
            description: 'Returns volume sum, rates, circuit diagnostics, and DLQ levels.',
          },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      BearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
      },
      ApiKeyAuth: {
        type: 'apiKey',
        in: 'header',
        name: 'X-API-Key',
      },
    },
  },
};
