# Nepal P2P Payment & Banking Observer Integration Guide (0% Fees)

This guide explains how to operate **YOUPI PG V2** in Nepal to collect payments directly into your Nepali bank accounts, eSewa, and Khalti with **0% gateway fees** using the real-time banking observer engine.

---

## 1. How It Works in Nepal

Instead of routing through commercial aggregator APIs that deduct 1.5%–2.5% per transaction, YOUPI PG runs a sovereign closed-loop observer:

```
[ Customer in Nepal ]
       │
       │ (1) Scans Fonepay QR or transfers to eSewa / Khalti
       ▼
[ Bank Account / eSewa / Khalti Wallet ]
       │
       │ (2) Bank/Wallet sends credit SMS or App Push Notification
       ▼
[ Android Phone running YOUPI Observer APK ]
       │
       │ (3) Evaluates on-device & posts HMAC-SHA256 signed event
       ▼
[ YOUPI PG Core (Port 6100) ]
       │
       │ (4) Attributes payment & dispatches authoritative webhook
       ▼
[ Merchant E-Commerce Backend ] (Marks Order as Paid)
```

---

## 2. Supported Nepali Providers & Apps

The following Nepali digital wallets, interbank QR networks, and commercial banks are officially supported by the observer regex engine and Android package allowlist:

| Provider / Channel | Android Package | SMS / Push Sender IDs | Reference Identifier |
| :--- | :--- | :--- | :--- |
| **eSewa** | `com.f1soft.esewa` | `eSewa` | `Txn ID: ESW...` |
| **Khalti** | `com.khalti` | `Khalti` | `Transaction ID: KHLT...` |
| **Fonepay Merchant** | `com.f1soft.fonepay.merchant` | `Fonepay` | `Trace ID: FP...` |
| **Fonepay Personal** | `com.f1soft.fonepay` | `Fonepay` | `Ref: ...` |
| **Nabil Bank** | `np.com.nabilbank.nabilmobile` | `NABIL_ALERT`, `NABIL` | `Ref: ...` / `Trace ID: ...` |
| **NIC Asia Bank** | `com.f1soft.nicasiabank` | `NIC_ASIA`, `NICASIA` | `Trace: ...` / `Ref: ...` |
| **Global IME Bank** | `com.f1soft.globalbank` | `GLOBAL_IME`, `GLOBAL` | `Trace ID: ...` / `Ref: ...` |
| **Sanima Bank** | `com.f1soft.sanima` | `SANIMA` | `Ref: ...` |
| **Everest Bank** | `com.f1soft.everestbank` | `EVEREST` | `Ref: ...` |
| **ConnectIPS** | `np.com.nchl.connectips` | `ConnectIPS` | `Txn ID: ...` |
| **Android SMS** | `com.google.android.apps.messaging` | Carrier Shortcodes | UTR / Trace / Ref |

---

## 3. Configuration & Setup

### Step 1: Set Default Currency to NPR
In your `.env` or application configuration:
```env
DEFAULT_CURRENCY=NPR
```

The gateway automatically handles formatting:
- Minor units: `1 NPR = 100 Paisa` (e.g. Rs. 499.00 = `49900` BigInt).
- Currency display: `Rs. 499.00`.

### Step 2: Set Up Android Observer Phone
1. Obtain an inexpensive Android phone (Android 8.0+) connected to Wi-Fi and kept plugged into a charger.
2. Install the observer app:
   - Download `youpi-sms-gateway.apk` from `http://localhost:6001/youpi-sms-gateway.apk`.
3. Open the **Merchant Admin Dashboard** (`http://localhost:6001`).
4. Go to **Observers & Devices** ➔ **Pair Android Device**.
5. Scan the pairing QR code from the Android app to exchange HMAC cryptographic signing keys.
6. In Android **Settings** ➔ **Notification Access**, enable access for **YOUPI SMS Gateway**.
7. Disable battery optimization (MIUI / ColorOS / OneUI) for the app to allow 24/7 background operation.

---

## 4. Webhook Payload Contract (Merchant Store)

When an incoming payment is confirmed by an observer, YOUPI PG dispatches an authoritative HMAC-SHA256 signed webhook to your store:

```json
{
  "event": "SUCCESS",
  "paymentId": "550e8400-e29b-41d4-a716-446655440000",
  "orderId": "ORD-NP-1001",
  "amount": "1200.00",
  "amountPaise": 120000,
  "currency": "NPR",
  "method": "FONEPAY",
  "utr": "FP99881122",
  "completedAt": "2026-11-16T18:30:00.000Z",
  "metadata": {
    "customer_phone": "9801234567"
  }
}
```

Verify the signature using your `YOUPI_WEBHOOK_SECRET` over the raw unparsed request body before fulfilling the order.

---

## 5. Simulating Payments in Development

You can simulate real-world Nepali notifications locally without needing an Android device:

### Test eSewa Transfer:
```bash
curl -X POST http://localhost:6100/api/v1/pollers/events \
  -H "Content-Type: application/json" \
  -d '{
    "source": "GOOGLE_MESSAGES",
    "receivingAccountId": "00000000-0000-0000-0000-000000000002",
    "rawText": "Received Rs. 500.00 from 9801234567. Remarks: Order-101. Txn ID: ESW241116001. Bal: Rs. 14,500.00"
  }'
```

### Test Fonepay Bank Transfer:
```bash
curl -X POST http://localhost:6100/api/v1/pollers/events \
  -H "Content-Type: application/json" \
  -d '{
    "source": "GOOGLE_MESSAGES",
    "receivingAccountId": "00000000-0000-0000-0000-000000000002",
    "rawText": "Your A/C ...1234 has been credited with NPR 1,200.00 on 16-Nov-2026 by Fonepay. Ref: FP99881122."
  }'
```

---

## 6. Account Pooling & 50 Daily Limit Auto-Rotation (Single Phone Solution)

### The 50 Payments/Day Hurdle in Nepal
In Nepal, personal wallets (eSewa, Khalti) and personal bank accounts are restricted by NRB / provider rules to a maximum number of incoming P2P transfers per day (typically **50 transactions per calendar day** for personal accounts) before blocking incoming credits or demanding merchant verification.

### Sovereign Multi-Account Pooling on ONE Device
YOUPI PG solves this hurdle without requiring multiple physical phones:
- A single Android phone can have multiple apps installed simultaneously (e.g. eSewa personal, Khalti personal, Fonepay, mobile banking apps).
- The phone receives notifications and SMS for all of them into the unified Android Notification Listener and SMS inbox.
- YOUPI PG maintains an **Account Pool** in the database with automated, atomic rotation.

### How It Works:
1. **Configured Daily Limit**: Each receiving account has a `daily_transaction_limit` (default: `50`, set to `0` for unlimited).
2. **Priority Tiers**: Each account has a `priority` number (higher priority accounts are selected first).
3. **Per-Account Custom QR**: Each account can have its own `custom_qr_string` (raw ConnectIPS EMVCo QR payload or specific wallet QR string).
4. **Automatic Daily Failover**:
   - When Account A processes its 50th completed transaction today, it reaches its daily threshold.
   - On the very next checkout session creation, YOUPI PG automatically queries the merchant pool, locates the next enabled account with capacity today (Account B), and atomically activates it.
   - Customers immediately see Account B's dynamic QR code and VPA.
   - At midnight UTC/local date rollover, the daily counters reset automatically.

### Adding Pooled Accounts via Merchant Admin:
1. Navigate to **Merchant Admin** (`http://localhost:6001`) ➔ **Settings** ➔ **Receiving Accounts**.
2. Under **Add New Receiving Account**:
   - **UPI ID / Wallet ID**: e.g., `9801234567@esewa` or `9841234567@khalti`
   - **Daily Limit**: `50` (or your preferred safety margin, e.g. `48`)
   - **Rotation Priority**: e.g., `10` for primary, `5` for secondary
   - **Custom QR String**: (Optional) Paste raw EMVCo ConnectIPS or wallet QR string
3. Click **Save & Add Account**.
4. Both accounts are monitored seamlessly by the single observer device!

