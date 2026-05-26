const BASE_URL = window.location.origin;

// State management
let adminKey = document.getElementById('admin-key').value;

// Event Listeners
document.getElementById('admin-key').addEventListener('change', (e) => {
  adminKey = e.target.value;
  saveCredentials();
});

document.getElementById('btn-refresh').addEventListener('click', () => {
  refreshDashboard();
});

document.getElementById('btn-load-payments').addEventListener('click', () => {
  loadRecentPayments();
});

// Control tabs switching
const tabButtons = document.querySelectorAll('.tab-btn');
const tabContents = document.querySelectorAll('.tab-content');

tabButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    tabButtons.forEach(b => b.classList.remove('active'));
    tabContents.forEach(c => c.classList.add('hidden'));

    btn.classList.add('active');
    const tabId = btn.getAttribute('data-tab');
    document.getElementById(tabId).classList.remove('hidden');
  });
});

// Modal actions
const modal = document.getElementById('payment-modal');
document.getElementById('btn-close-modal').addEventListener('click', () => {
  modal.classList.add('hidden');
});

// Webhook Simulator submit
document.getElementById('webhook-simulator-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const gateway = document.getElementById('sim-gateway').value;
  const txId = document.getElementById('sim-tx-id').value.trim();
  const eventId = document.getElementById('sim-event-id').value.trim() || `evt_${Math.random().toString(36).substring(2, 11)}`;
  const amount = parseInt(document.getElementById('sim-amount').value, 10);
  const status = document.getElementById('sim-status').value;
  const duplicate = document.getElementById('sim-duplicate').checked;

  if (!txId) {
    alert('Please enter a Transaction UUID first!');
    return;
  }

  // Build simulated payload
  let payload = {};
  if (gateway === 'Stripe') {
    payload = {
      id: eventId,
      object: 'event',
      type: status === 'captured' ? 'payment_intent.succeeded' : 'payment_intent.payment_failed',
      data: {
        object: {
          id: `pi_${txId}`,
          amount: amount / 100,
          currency: 'inr',
          status: status === 'captured' ? 'succeeded' : 'requires_payment_method',
          metadata: { transaction_id: txId }
        }
      }
    };
  } else if (gateway === 'Razorpay') {
    payload = {
      id: eventId,
      entity: 'event',
      event: status === 'captured' ? 'payment.captured' : 'payment.failed',
      payload: {
        payment: {
          entity: {
            id: `pay_${txId}`,
            amount: amount,
            currency: 'INR',
            status: status === 'captured' ? 'captured' : 'failed',
            notes: { transaction_id: txId }
          }
        }
      }
    };
  } else {
    payload = {
      event_id: eventId,
      transaction_id: txId,
      gateway_reference: `${gateway.toLowerCase()}_ref_${txId}`,
      amount: amount.toString(),
      status: status === 'captured' ? 'SUCCESS' : 'FAILED'
    };
  }

  const webhookSecret = 'secret'; // fallback secret
  const headers = {
    'Content-Type': 'application/json',
    'X-Webhook-Signature': 'simulated_signature',
    'X-Webhook-Timestamp': Math.floor(Date.now() / 1000).toString()
  };

  try {
    const response = await fetch(`${BASE_URL}/api/v1/webhooks/${gateway.toLowerCase()}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });
    const result = await response.json();
    alert(`Webhook Posted: ${response.status} ${response.statusText}\n${JSON.stringify(result)}`);
    
    if (duplicate) {
      setTimeout(async () => {
        const dupResponse = await fetch(`${BASE_URL}/api/v1/webhooks/${gateway.toLowerCase()}`, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload)
        });
        console.log('Duplicate webhook response:', dupResponse.status);
      }, 1000);
    }

    refreshDashboard();
    loadRecentPayments();
  } catch (err) {
    alert(`Error: ${err.message}`);
  }
});

// Trigger Reconciliation
document.getElementById('btn-trigger-recon').addEventListener('click', async () => {
  const resultDiv = document.getElementById('recon-trigger-result');
  resultDiv.innerText = 'Triggering...';
  
  try {
    const response = await fetch(`${BASE_URL}/api/v1/reconciliation/trigger`, {
      method: 'POST',
      headers: { 'X-API-Key': adminKey }
    });
    
    if (response.status === 401) {
      resultDiv.innerHTML = '<span class="text-danger">Unauthorized! Check API Key.</span>';
      return;
    }

    const data = await response.json();
    resultDiv.innerHTML = `<span class="text-success">Success! Enqueued ${data.enqueued_jobs} checking tasks.</span>`;
    
    setTimeout(() => {
      refreshDashboard();
      loadRecentPayments();
    }, 1500);
  } catch (err) {
    resultDiv.innerHTML = `<span class="text-danger">Failed: ${err.message}</span>`;
  }
});

// Fetch metrics & stats
async function refreshDashboard() {
  try {
    const response = await fetch(`${BASE_URL}/api/v1/analytics/dashboard`, {
      headers: { 'X-API-Key': adminKey }
    });

    if (response.status === 401) {
      alert('Dashboard access unauthorized! Please enter a valid Admin API Key in the header.');
      return;
    }

    const data = await response.json();
    updateDashboardStats(data);
  } catch (err) {
    console.error('Error refreshing dashboard:', err);
  }
}

function updateDashboardStats(data) {
  // 1. Update volume card
  const volumes = data.analytics?.volume || [];
  const inrVolume = volumes.find(v => v.currency === 'INR');
  if (inrVolume) {
    const amt = parseInt(inrVolume.volume_paise, 10) / 100;
    document.getElementById('val-volume').innerText = `INR ${amt.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
    document.getElementById('val-volume-tx-count').innerText = `${inrVolume.transaction_count} settled transactions`;
  } else {
    document.getElementById('val-volume').innerText = 'INR 0.00';
    document.getElementById('val-volume-tx-count').innerText = '0 settled transactions';
  }

  // 2. Success rate
  const globalRate = data.analytics?.success_rate?.global || {};
  const ratePct = ((globalRate.success_rate || 1.0) * 100).toFixed(1);
  document.getElementById('val-success-rate').innerText = `${ratePct}%`;
  document.getElementById('fill-success-rate').style.width = `${ratePct}%`;

  // 3. Anomalies
  const activeAnomaliesCount = data.reconciliation?.unresolved_anomalies || 0;
  document.getElementById('val-anomalies').innerText = activeAnomaliesCount;
  
  const anomalyPanel = document.getElementById('anomaly-panel');
  if (activeAnomaliesCount > 0) {
    anomalyPanel.classList.remove('hidden');
    loadAnomalies();
  } else {
    anomalyPanel.classList.add('hidden');
  }

  // 4. DLQ Depth
  document.getElementById('val-dlq').innerText = data.queues?.dead_letter_queue_depth || 0;
  document.getElementById('val-webhook-backlog').innerText = `${data.queues?.webhook_backlog || 0} pending in webhook queue`;

  // 5. Render Circuits list
  const circuits = data.circuits || [];
  const circuitsContainer = document.getElementById('gateway-circuits-list');
  circuitsContainer.innerHTML = '';

  if (circuits.length === 0) {
    circuitsContainer.innerHTML = '<p class="loading">No gateways configured.</p>';
    return;
  }

  circuits.forEach(c => {
    const item = document.createElement('div');
    item.className = 'gateway-item';
    
    let statusClass = 'circuit-closed';
    if (c.state === 'OPEN') statusClass = 'circuit-open';
    if (c.state === 'HALF_OPEN') statusClass = 'circuit-half';

    item.innerHTML = `
      <div class="gw-info-left">
        <h4>${c.gateway} <span style="font-size:0.8rem; font-weight:300;">(${c.payment_method})</span></h4>
        <p>Latency: <strong>${Math.round(c.avg_latency_ms)}ms</strong> | Success Rate: <strong>${(c.success_rate * 100).toFixed(0)}%</strong></p>
      </div>
      <div class="gw-status-right">
        <span class="circuit-badge ${statusClass}">${c.state}</span>
        ${c.failure_count > 0 ? `<span style="font-size:0.75rem; color:var(--color-danger);">Failures: ${c.failure_count}</span>` : ''}
      </div>
    `;
    circuitsContainer.appendChild(item);
  });
}

// Fetch Anomalies list
async function loadAnomalies() {
  try {
    const response = await fetch(`${BASE_URL}/api/v1/reconciliation/anomalies`, {
      headers: { 'X-API-Key': adminKey }
    });
    const anomalies = await response.json();
    
    const body = document.getElementById('anomaly-table-body');
    body.innerHTML = '';
    
    if (anomalies.length === 0) {
      body.innerHTML = '<tr><td colspan="5" style="text-align:center;">No active anomalies!</td></tr>';
      return;
    }

    anomalies.forEach(a => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${a.gateway}</strong></td>
        <td><span class="state-badge">${a.internal_state}</span></td>
        <td><span class="state-badge">${a.gateway_state}</span></td>
        <td><span class="state-badge ${a.severity === 'HIGH' ? 'state-failed' : 'state-authorised'}">${a.severity}</span></td>
        <td>${a.notes}</td>
      `;
      body.appendChild(tr);
    });
  } catch (err) {
    console.error('Error loading anomalies:', err);
  }
}

// Fetch payments table
async function loadRecentPayments() {
  const tableBody = document.getElementById('payments-table-body');
  
  try {
    const response = await fetch(`${BASE_URL}/api/v1/payments`, {
      headers: { 'X-API-Key': adminKey }
    });

    if (response.status === 401) {
      tableBody.innerHTML = '<tr><td colspan="6" class="loading text-danger">Unauthorized! Verify X-API-Key.</td></tr>';
      return;
    }

    const payments = await response.json();
    tableBody.innerHTML = '';

    if (payments.length === 0) {
      tableBody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding:30px;">No transaction records found. Try initiating a payment!</td></tr>';
      return;
    }

    payments.forEach(p => {
      const tr = document.createElement('tr');
      const amt = parseInt(p.amount_paise, 10) / 100;
      const statusClass = `state-${p.status.toLowerCase()}`;
      
      tr.innerHTML = `
        <td><strong>${p.merchant_order_id}</strong></td>
        <td>${p.gateway_name || '<span style="color:var(--color-text-muted);">None</span>'}</td>
        <td>${p.currency} ${amt.toFixed(2)}</td>
        <td><span class="state-badge ${statusClass}">${p.status}</span></td>
        <td>${new Date(p.created_at).toLocaleString()}</td>
        <td>
          <button class="btn-timeline" data-id="${p.id}" style="background:none; border:none; color:var(--accent-cyan); cursor:pointer; text-decoration:underline; font-size:0.85rem;">Timeline</button>
          <button class="btn-copy-id" data-id="${p.id}" style="background:none; border:none; color:var(--color-text-muted); cursor:pointer; font-size:0.85rem; margin-left:8px;" title="Copy UUID">📋</button>
        </td>
      `;
      tableBody.appendChild(tr);
    });

    // Add timeline listeners
    document.querySelectorAll('.btn-timeline').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const id = e.target.getAttribute('data-id');
        showTimeline(id);
      });
    });

    // Copy ID listener
    document.querySelectorAll('.btn-copy-id').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const id = e.target.getAttribute('data-id');
        navigator.clipboard.writeText(id);
        alert('Transaction UUID copied to clipboard!');
      });
    });
  } catch (err) {
    tableBody.innerHTML = `<tr><td colspan="6" class="loading text-danger">Error: ${err.message}</td></tr>`;
  }
}

// Show timeline in modal
async function showTimeline(id) {
  const modalTimeline = document.getElementById('modal-timeline');
  modalTimeline.innerHTML = '<p class="loading">Loading transition logs...</p>';
  modal.classList.remove('hidden');

  try {
    // 1. Fetch details
    const detRes = await fetch(`${BASE_URL}/api/v1/payments/${id}`, {
      headers: { 'X-API-Key': adminKey }
    });
    const tx = await detRes.json();

    document.getElementById('modal-tx-id').innerText = tx.id;
    document.getElementById('modal-order-id').innerText = tx.merchant_order_id;
    document.getElementById('modal-idemp-key').innerText = tx.idempotency_key;

    // Load in form to test webhook simulator
    document.getElementById('sim-tx-id').value = tx.id;
    document.getElementById('sim-amount').value = tx.amount_paise;

    // 2. Fetch log timeline
    const logRes = await fetch(`${BASE_URL}/api/v1/payments/${id}/timeline`, {
      headers: { 'X-API-Key': adminKey }
    });
    const logs = await logRes.json();

    modalTimeline.innerHTML = '';
    logs.forEach(l => {
      const item = document.createElement('div');
      item.className = 'timeline-item';
      
      const time = new Date(l.created_at).toLocaleString();
      item.innerHTML = `
        <div class="timeline-dot"></div>
        <div class="timeline-content">
          <h4>${l.from_state} &rarr; ${l.to_state}</h4>
          <p>${l.reason || 'No description provided'}</p>
          <p style="font-size:0.7rem; color:var(--color-text-muted); margin-top:2px;">
            By: <strong>${l.created_by}</strong> | Gateway: <strong>${l.gateway || 'None'}</strong> | Time: ${time}
          </p>
        </div>
      `;
      modalTimeline.appendChild(item);
    });
  } catch (err) {
    modalTimeline.innerHTML = `<p class="loading text-danger">Error: ${err.message}</p>`;
  }
}

// Save credentials
function saveCredentials() {
  localStorage.setItem('payflow_admin_key', adminKey);
}

// Load credentials
function loadCredentials() {
  const savedKey = localStorage.getItem('payflow_admin_key');
  if (savedKey) {
    adminKey = savedKey;
    document.getElementById('admin-key').value = savedKey;
  }
}

// Init
loadCredentials();
refreshDashboard();
loadRecentPayments();

// Auto refresh dashboard metrics every 10 seconds
setInterval(() => {
  refreshDashboard();
}, 10000);
