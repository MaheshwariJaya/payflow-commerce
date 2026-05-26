# Makefile for PayFlow Commerce Payment Orchestration Layer

.PHONY: install db-setup seed run-server run-worker test integration-test check-all clean

# Install node dependencies
install:
	npm install

# Run database migrations and generate prisma client
db-setup:
	npx prisma db push
	npx prisma generate

# Seed the database with initial configurations
seed: db-setup
	npm run db:seed

# Start the API server locally
run-server:
	npm run dev

# Start the background queue worker locally
run-worker:
	npm run worker

# Run unit tests (uses jest configuration with mocked prisma/redis)
test:
	npm run test

# Run integration tests (runs against the real local Postgres and Redis databases)
integration-test:
	npx jest --config jest.integration.config.js --runInBand

# Check and verify all 19 checklist items
check-all:
	npx ts-node tests/verify-checklist.ts

# Clean build artifacts
clean:
	npx rimraf dist
