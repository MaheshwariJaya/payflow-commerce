# PayFlow Commerce - Payment Orchestration Layer

PayFlow Commerce is a production-grade, highly resilient Payment Orchestration Layer backend built with Node.js, Express.js, TypeScript, PostgreSQL (Prisma ORM), Redis, and Docker. It dynamically routes payments across multiple gateways (Stripe, Razorpay, PayU, UPI) using an intelligent scoring engine, handles automated failovers within 2 seconds, protects against double charging via distributed locks, and securely processes out-of-order webhook deliveries.

---

## Key Features

1. **Intelligent Dynamic Routing**: Automatically scores and selects the best gateway for each transaction based on success rates, average latency, processing cost, circuit health, and payment method fit.
2. **2-Second Failover Guarantee**: Enforces strict execution time budgets on external API requests using `AbortController` timeouts. Automatically routes to alternative gateways if the primary fails or times out.
3. **Double Charge Prevention**: Utilizes Redis-backed distributed locks and PostgreSQL advisory locks combined with request-hash payload validation to guarantee strict idempotency.
4. **Resilient Webhook Queue**: Asynchronously processes incoming webhooks using BullMQ (Redis-backed queues), verify HMAC-SHA256 signatures, validate timestamps to prevent replay attacks, and routes failed events to the database Dead Letter Queue (DLQ).
5. **Compensating Out-of-Order Webhooks**: Automatically generates and executes sequential compensating state transitions (e.g. `CREATED` -> `ROUTE_SELECTED` -> `AUTH_INITIATED` -> `AUTHORISED` -> `CAPTURE_INITIATED` -> `CAPTURED`) if webhook notifications arrive before API responses.
6. **Detailed Audit Trails & Reconciliation**: Logs every single transaction state mutation in an immutable log. Exposes a reconciliation engine that matches logs against gateway details, flag discrepancies, and flags anomalies.
7. **Distributed Tracing & Metrics**: Integrates OpenTelemetry spans across routes/workers and exposes Prometheus metrics at `/metrics` (gauges for DLQ backlog, circuit status, latency percentiles).
8. **Ambient Admin Dashboard UI**: Includes a gorgeous, dark-mode glassmorphism admin panel served directly at `/dashboard` to monitor gateway states, success rate curves, active anomalies, and test mock webhook deliveries.

---

## Clean Architecture Structure

The project follows clean architecture separation of concerns:

```
├── public/                 # Glassmorphic Admin Dashboard frontend files
├── prisma/                 # Database Schema, Migrations, and Seeding scripts
├── tests/                  # Jest Unit and Integration test suite
├── src/
│   ├── config/             # Connection pool definitions (Redis, Telemetry)
│   ├── state-machine/      # Transaction State Machine transitions & domain event hooks
│   ├── routing-engine/     # Scored gateway calculations & payment method priority matrix
│   ├── gateways/           # Adapter Factory, Stripe/Razorpay/PayU/UPI adaptors, & Circuit Breaker
│   ├── repositories/       # Database access queries using Prisma client
│   ├── services/           # Core payment orchestration, webhooks, and reconciliation logic
│   ├── controllers/        # Express HTTP controller layer (Request/Response parse)
│   ├── middleware/         # Security headers, Tracing context, Rate limits, Idempotency checks
│   ├── queue/              # BullMQ queue creators and background Worker scripts
│   ├── utils/              # Crypto helper (AES-256-GCM), Advisory locks, Timeout wrapper
│   ├── app.ts              # Express middleware assembly & route setups
│   └── server.ts           # Telemetry boot and server listener
```

---

## Getting Started (Docker Compose)

The easiest way to boot the database, Redis cache, API server, background queue workers, and Nginx reverse proxy is using Docker Compose:

### 1. Configure Environment variables
Copy the template `.env.example` into a new `.env` file:
```bash
cp .env.example .env
```

### 2. Boot Services
Execute the compose build and up command:
```bash
docker-compose up --build
```
This command automatically:
- Starts PostgreSQL database and Redis server.
- Connects the API service and runs Prisma database sync (`db push`) and seeds default gateway records.
- Launches background workers listening to BullMQ queues.
- Launches Nginx listening on port `80`, reverse proxying incoming calls to the API.

---

## Access Points & URLs

- **API Base Url**: `http://localhost` (or `http://localhost:3000` directly bypassing Nginx proxy)
- **Admin Dashboard UI**: [http://localhost/dashboard](http://localhost/dashboard) (or `http://localhost:3000/dashboard`)
- **API Swagger Documentation**: [http://localhost/api-docs](http://localhost/api-docs)
- **Prometheus Metrics**: [http://localhost/metrics](http://localhost/metrics)
- **System Health Status**: `GET http://localhost/api/v1/health`

---

## Testing & Mock Failure Simulations

To test the failover and error recovery pipelines, pass specific trigger strings inside the `merchant_order_id` parameter when initiating a payment:

| Trigger Keyword | Simulated Behavior | Expected System Action |
| :--- | :--- | :--- |
| `sim_success` | Fast success response | Payment AUTHORISED/CAPTURED instantly. |
| `sim_timeout` | Sleeps for 6.0 seconds | Stripe/Razorpay times out (budget limit 2s). Auto-failovers to the next highest-scoring gateway. |
| `sim_500` | Gateway returns HTTP 500 | Main gateway fails. System immediately switches to the fallback gateway. |
| `sim_failure` | Gateway returns declined card | Gateway fails. Tripper counts error and checks next gateway. |
| `sim_delayed_webhook` | Callback hook delayed by 8s | Response returns, webhook worker processes capture after delay. |
| `sim_out_of_order` | Webhook triggers immediately | Webhook triggers capture before API response resolves. State machine executes compensating path. |

---

## Testing Command lines

### Run Jest Test Suite (Unit & Integration)
```bash
npm run test
```

### Run k6 Load Performance test
Ensure `k6` is installed on your local path, then execute:
```bash
k6 run k6-load-test.js
```

---

## API Endpoints List

### Payments
- `POST /api/v1/payments`: Process payment (requires `Idempotency-Key` header, `Bearer` JWT).
- `GET /api/v1/payments`: List 20 most recent payments (requires `X-API-Key` or `Bearer` JWT).
- `GET /api/v1/payments/:id`: Get payment details.
- `POST /api/v1/payments/:id/capture`: Capture authorized payment.
- `POST /api/v1/payments/:id/refund`: Refund captured payment.
- `POST /api/v1/payments/:id/void`: Void authorized payment.
- `GET /api/v1/payments/:id/timeline`: Get audit timeline logs.

### Webhooks
- `POST /api/v1/webhooks/razorpay`: Public Razorpay webhook.
- `POST /api/v1/webhooks/stripe`: Public Stripe webhook.
- `POST /api/v1/webhooks/payu`: Public PayU webhook.
- `POST /api/v1/webhooks/upi`: Public UPI webhook.
- `POST /api/v1/webhooks/replay/:event_id`: Replay failed webhook event (requires admin `X-API-Key`).

### Configurations
- `GET /api/v1/config/gateways`: List configurations.
- `PUT /api/v1/config/gateways/:name/config`: Update credentials, active flags, limits.
- `GET /api/v1/config/routing/config`: View routing weights.
- `PUT /api/v1/config/routing/config`: Modify weights & priority matrix.

### Administrative & Diagnostics
- `POST /api/v1/reconciliation/trigger`: Trigger bulk reconciliation job scan.
- `GET /api/v1/reconciliation/anomalies`: Get unresolved anomalies.
- `GET /api/v1/analytics/dashboard`: Fetch volume, success rates, circuit status, and DLQ levels.
