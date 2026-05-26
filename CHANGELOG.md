# Changelog

All notable changes and architectural features built for **PayFlow Commerce - Payment Orchestration Layer** are documented in this file.

---

## [1.0.0] - 2026-05-26

### Added
- **Core Orchestration & Routing Engine**:
  - Built a dynamic routing engine that grades candidates using weights for success rate, latency, cost, priority fit, and circuit breaker status.
  - Implemented concrete adapters for **Stripe**, **Razorpay**, **PayU**, and **UPI** gateways.
  - Added a gateway adapter factory to retrieve adapter instances dynamically.
- **Failover & Timeout Guarantees**:
  - Implemented an `AbortController`-based `withTimeout` wrapper to limit gateway API calls to a strict 2000ms budget.
  - Implemented automatic cascading failovers to alternative gateways when a primary gateway fails or times out.
- **Concurrency & Double-Charge Protection**:
  - Set up Redis distributed locks (`LockUtil.acquireRedisLock`) to prevent race conditions on mutating requests.
  - Added PostgreSQL transaction-level advisory locks (`LockUtil.acquirePostgresAdvisoryLock`) to serialize state transitions for the same transaction ID.
  - Integrated request-hash payload validation in the idempotency middleware.
- **Resilient Webhook Queue**:
  - Configured BullMQ (Redis-backed queues) for asynchronous webhook parsing and processing.
  - Implemented webhook signature verification (e.g. HMAC verification, Stripe signature parts) and timestamp verification (5-minute replay protection window).
  - Created a Dead Letter Queue (DLQ) in the database for events exceeding 5 retry attempts.
  - Added support for webhook replay endpoint to requeue failed webhook events.
- **Compensating Out-of-Order Webhooks Handler**:
  - Created a State Machine (`TransactionStateMachine`) that validates state transitions.
  - Added auto-resolution for out-of-order webhooks (e.g., webhook arrives before API response) by expanding the target transition into a compensating sequential path (e.g. `CREATED` -> `ROUTE_SELECTED` -> `AUTH_INITIATED` -> `AUTHORISED` -> `CAPTURE_INITIATED` -> `CAPTURED`).
- **Reconciliation & Auditing**:
  - Added transaction state change logs (`TransactionStateLog`) to record all transitions with reasons, actors, and trace metadata.
  - Developed a reconciliation service (`ReconciliationService`) to query gateway state/amount reports, detect status or amount anomalies, and mark transactions as settled (`SETTLED`).
  - Added a bulk reconciliation scanner to identify unresolved transactions older than 1 minute.
- **Distributed Tracing & Metrics**:
  - Instrumented OpenTelemetry spans across routers, services, and queue workers.
  - Exposed Prometheus metrics (gauge for DLQ length, average latencies, circuit states, and success rates) at `/metrics`.
- **Glassmorphic Admin Dashboard UI**:
  - Built a premium dark-mode dashboard `/dashboard` containing metrics cards, real-time success-rate charts, gateway circuit status indicator LEDs, unresolved anomaly lists, and a webhook simulation generator for testing.
- **Development Tooling & Code Quality**:
  - Integrated ESLint v10 (Flat Configuration) and Prettier for strict static analysis and styling.
  - Added lint and format scripts (`npm run lint`, `npm run format:fix`) to `package.json`.
- **Docker Compose Setup**:
  - Formulated a multi-stage `Dockerfile` with system dependencies (`openssl` and `libc6-compat`) for Alpine runtime compatibility with Prisma engines.
  - Set up `docker-compose.yml` defining PostgreSQL (db), Redis, Nginx reverse proxy, API, and worker services.

### Fixed
- Resolved all compiler and linter unused-variable/unused-import errors across all controllers, adapters, queue workers, and tests.
- Replaced standard console logging statements in configuration connection handlers with the unified Winston/Pino logger.
- Addressed Docker Alpine initialization error where the Prisma engine failed to load due to missing shared SSL libraries.

### Verified
- Executed full test suite containing 16 unit and integration tests (idempotency, failovers, state machine, routing, and circuit breaker logic) with 100% success rate.
- Validated Docker container boot-up sequence from a clean state.
