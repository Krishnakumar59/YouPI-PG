process.env.YOUPI_MODE = 'localhost';
process.env.NODE_ENV = 'test';
process.env.YOUPI_ALLOW_PRIVATE_WEBHOOKS = 'true';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '@youpi/db';
import { startServer as startPaymentApi } from '../index.js';
import { authFetch } from '../../../../scripts/test-support.js';

describe('Receiving Account Daily Limit & Failover Auto-Rotation HTTP Integration Tests', () => {
  let apiInstance;
  let testDb;
  let baseUrl;
  const merchantId = '00000000-0000-0000-0000-000000000001';

  before(async () => {
    testDb = new Database({ inMemory: true });
    apiInstance = await startPaymentApi(6219, testDb);
    baseUrl = 'http://localhost:6219';
  });

  after(async () => {
    if (apiInstance) {
      await apiInstance.close();
    }
    if (testDb) {
      testDb.close();
    }
  });

  it('1. GET /api/v1/admin/upi-accounts returns default account with dailyTransactionLimit = 50 and usage metrics', async () => {
    const res = await authFetch(`${baseUrl}/api/v1/admin/upi-accounts?merchantId=${merchantId}`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.accounts));
    assert.ok(body.accounts.length >= 1);

    const defaultAcc = body.accounts[0];
    assert.strictEqual(defaultAcc.dailyTransactionLimit, 50);
    assert.strictEqual(defaultAcc.priority, 0);
    assert.strictEqual(defaultAcc.completedToday, 0);
    assert.strictEqual(defaultAcc.remainingToday, 50);
    assert.strictEqual(defaultAcc.isExhausted, false);
  });

  it('2. POST /api/v1/admin/upi-accounts creates multiple accounts with custom daily limits, priority, and custom QR payloads', async () => {
    // Add primary eSewa wallet with daily limit of 1 and priority 10
    const res1 = await authFetch(`${baseUrl}/api/v1/admin/upi-accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        merchantId,
        upiId: '9801234567@esewa',
        payeeName: 'Primary eSewa Store',
        isActive: true,
        dailyTransactionLimit: 1,
        priority: 10,
        customQrString: '0002010102125204599953035245802NP5918PRIMARY_ESEWA6009KATHMANDU62160112CONNECTIPS_QR6304ABCD'
      })
    });
    assert.strictEqual(res1.status, 201);
    const body1 = await res1.json();
    assert.strictEqual(body1.account.upiId, '9801234567@esewa');
    assert.strictEqual(body1.account.dailyTransactionLimit, 1);
    assert.strictEqual(body1.account.priority, 10);
    assert.ok(body1.account.customQrString.includes('PRIMARY_ESEWA'));

    // Add standby Khalti wallet with daily limit of 50 and priority 5
    const res2 = await authFetch(`${baseUrl}/api/v1/admin/upi-accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        merchantId,
        upiId: '9841234567@khalti',
        payeeName: 'Secondary Khalti Store',
        isActive: false,
        dailyTransactionLimit: 50,
        priority: 5,
        customQrString: '0002010102125204599953035245802NP5918SECONDARY_KHALTI6009KATHMANDU62160112CONNECTIPS_QR6304EF01'
      })
    });
    assert.strictEqual(res2.status, 201);
    const body2 = await res2.json();
    assert.strictEqual(body2.account.upiId, '9841234567@khalti');
    assert.strictEqual(body2.account.dailyTransactionLimit, 50);
    assert.strictEqual(body2.account.priority, 5);
  });

  it('3. PATCH /api/v1/admin/upi-accounts/:id updates dailyTransactionLimit and priority', async () => {
    const listRes = await authFetch(`${baseUrl}/api/v1/admin/upi-accounts?merchantId=${merchantId}`);
    const list = await listRes.json();
    const khaltiAcc = list.accounts.find(a => a.upiId === '9841234567@khalti');
    assert.ok(khaltiAcc);

    const patchRes = await authFetch(`${baseUrl}/api/v1/admin/upi-accounts/${khaltiAcc.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dailyTransactionLimit: 25,
        priority: 8
      })
    });
    assert.strictEqual(patchRes.status, 200);
    const patchBody = await patchRes.json();
    assert.strictEqual(patchBody.account.dailyTransactionLimit, 25);
    assert.strictEqual(patchBody.account.priority, 8);
  });

  it('4. Session 1 uses Primary account; upon completing 1 payment (limit reached), Session 2 automatically rotates to Secondary account', async () => {
    // Create Session 1
    const s1Res = await authFetch(`${baseUrl}/api/v1/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        merchantId,
        orderId: 'ROT-TEST-ORD-01',
        amount: '250.00',
        currency: 'NPR',
        customer: { name: 'Ram Thapa', mobileNumber: '9801234567', email: 'ram@example.com' }
      })
    });
    assert.strictEqual(s1Res.status, 201);
    const s1Data = await s1Res.json();

    // Verify Session 1 was allocated to the Primary eSewa account
    assert.ok(s1Data.paymentId);
    const s1StateRes = await authFetch(`${baseUrl}/api/v1/checkout/${s1Data.paymentId}/state`);
    const s1State = await s1StateRes.json();
    assert.strictEqual(s1State.payeeVpa, '9801234567@esewa');
    assert.ok(s1State.customQrString.includes('PRIMARY_ESEWA'));

    // Complete Session 1 in database (reaches 1 / 1 daily limit on Primary eSewa account)
    testDb.execute(
      "UPDATE payment_sessions SET status = 'SUCCESS', completed_at = datetime('now') WHERE id = ?",
      [s1Data.paymentId]
    );

    // Verify admin accounts list reports Primary eSewa as exhausted
    const checkRes = await authFetch(`${baseUrl}/api/v1/admin/upi-accounts?merchantId=${merchantId}`);
    const checkList = await checkRes.json();
    const primaryAcc = checkList.accounts.find(a => a.upiId === '9801234567@esewa');
    assert.strictEqual(primaryAcc.completedToday, 1);
    assert.strictEqual(primaryAcc.isExhausted, true);

    // Create Session 2
    const s2Res = await authFetch(`${baseUrl}/api/v1/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        merchantId,
        orderId: 'ROT-TEST-ORD-02',
        amount: '500.00',
        currency: 'NPR',
        customer: { name: 'Sita Sharma', mobileNumber: '9841234567', email: 'sita@example.com' }
      })
    });
    assert.strictEqual(s2Res.status, 201);
    const s2Data = await s2Res.json();

    // Verify Session 2 was automatically rotated to Secondary Khalti account!
    const s2StateRes = await authFetch(`${baseUrl}/api/v1/checkout/${s2Data.paymentId}/state`);
    const s2State = await s2StateRes.json();
    assert.strictEqual(s2State.payeeVpa, '9841234567@khalti', 'Must auto-rotate to secondary account after primary reaches daily limit');
    assert.ok(s2State.customQrString.includes('SECONDARY_KHALTI'));
  });
});
