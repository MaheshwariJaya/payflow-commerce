import http from 'k6/http';
import { check, sleep } from 'k6';
import { uuidv4 } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

// Configuration scenarios
export const options = {
  scenarios: {
    constant_load: {
      executor: 'constant-vus',
      vus: 10, // 10 concurrent virtual users
      duration: '30s', // run for 30 seconds
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<2500'], // P95 response time under 2.5s (incorporating failover timeouts)
    http_req_failed: ['rate<0.05'],    // less than 5% request failures
  },
};

const BASE_URL = 'http://localhost:3000';

// Setup phase: generate authorization token
export function setup() {
  const url = `${BASE_URL}/api/v1/auth/token`;
  const payload = JSON.stringify({
    customer_id: 'k6_performance_user',
  });
  const params = {
    headers: { 'Content-Type': 'application/json' },
  };

  const res = http.post(url, payload, params);
  const token = JSON.parse(res.body).access_token;
  return { token };
}

export default function (data) {
  const url = `${BASE_URL}/api/v1/payments`;
  
  // Mix regular success requests with simulated timeout failovers (10%)
  const isTimeout = Math.random() < 0.1;
  const merchantOrderId = isTimeout 
    ? `k6_order_${uuidv4()}_sim_timeout` 
    : `k6_order_${uuidv4()}_sim_success`;

  const payload = JSON.stringify({
    amount_paise: 50000, // 500 INR
    currency: 'INR',
    payment_method: 'CARD',
    customer_id: 'k6_customer',
    merchant_order_id: merchantOrderId,
    metadata: { test: 'load' }
  });

  const params = {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${data.token}`,
      'Idempotency-Key': uuidv4(),
    },
  };

  const res = http.post(url, payload, params);

  // Assertions
  check(res, {
    'status is 201 (Created) or 429 (Rate Limited)': (r) => r.status === 201 || r.status === 429,
    'response has trace id': (r) => r.headers['X-Trace-Id'] !== undefined,
  });

  // Think time
  sleep(1);
}
