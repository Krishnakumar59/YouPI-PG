import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { BankSmsParser, ObservationNormalizer } from '../index.js';
import { extractIntelligentAmount } from '../bank-sms-parser.js';
import { ObserverSource } from '@youpi/common';

describe('Nepal Bank & Digital Wallet SMS / Push Notification Parser Tests', () => {
  describe('extractIntelligentAmount for Nepali Currency (Rs., NPR, Paisa)', () => {
    test('extracts amounts with NPR prefix', () => {
      const res = extractIntelligentAmount('Your account has been credited with NPR 1,500.00 on 16-Nov-2026.');
      assert.ok(res);
      assert.equal(res.amountStr, '1500.00');
      assert.equal(res.amountPaise, 150000n);
    });

    test('extracts amounts with NPR suffix', () => {
      const res = extractIntelligentAmount('Payment of 750.50 NPR received via Fonepay.');
      assert.ok(res);
      assert.equal(res.amountStr, '750.50');
      assert.equal(res.amountPaise, 75050n);
    });

    test('filters out NPR available balance and extracts payment amount', () => {
      const res = extractIntelligentAmount('A/C *1234 credited with NPR 500.00. Avl Bal NPR 50,000.00.');
      assert.ok(res);
      assert.equal(res.amountStr, '500.00');
      assert.equal(res.amountPaise, 50000n);
    });
  });

  describe('eSewa Wallet Notifications', () => {
    test('parses standard eSewa money received SMS with Txn ID', () => {
      const sms = {
        sender: 'eSewa',
        text: 'Received Rs. 500.00 from 9801234567 (Ram Sharma). Remarks: Order-101. Txn ID: ESW241116001. Current Bal: Rs. 14,500.00',
        timestamp: Date.now()
      };
      const parsed = BankSmsParser.parse(sms);
      assert.ok(parsed);
      assert.equal(parsed.amount, '500.00');
      assert.equal(parsed.amountPaise, 50000n);
      assert.equal(parsed.bankReferenceNumber, 'ESW241116001');
      assert.equal(parsed.senderVpa, '9801234567');
    });

    test('parses eSewa push notification format', () => {
      const notif = {
        sender: 'eSewa',
        text: 'Money Received: Rs. 1,200.00 received from 9812345678. Transaction ID: 987654321',
        timestamp: Date.now()
      };
      const parsed = BankSmsParser.parse(notif);
      assert.ok(parsed);
      assert.equal(parsed.amount, '1200.00');
      assert.equal(parsed.amountPaise, 120000n);
      assert.equal(parsed.bankReferenceNumber, '987654321');
      assert.equal(parsed.senderVpa, '9812345678');
    });
  });

  describe('Khalti Wallet Notifications', () => {
    test('parses Khalti money received SMS with Transaction ID', () => {
      const sms = {
        sender: 'Khalti',
        text: 'You have received Rs. 450.00 from 9841234567. Transaction ID: KHLT987654. Your current balance is Rs. 5,000.00',
        timestamp: Date.now()
      };
      const parsed = BankSmsParser.parse(sms);
      assert.ok(parsed);
      assert.equal(parsed.amount, '450.00');
      assert.equal(parsed.amountPaise, 45000n);
      assert.equal(parsed.bankReferenceNumber, 'KHLT987654');
      assert.equal(parsed.senderVpa, '9841234567');
    });

    test('parses Khalti push notification format', () => {
      const notif = {
        sender: 'Khalti',
        text: 'Payment Received: Rs 750.00 has been credited to your Khalti wallet from 9860123456. Txn ID: 11223344',
        timestamp: Date.now()
      };
      const parsed = BankSmsParser.parse(notif);
      assert.ok(parsed);
      assert.equal(parsed.amount, '750.00');
      assert.equal(parsed.amountPaise, 75000n);
      assert.equal(parsed.bankReferenceNumber, '11223344');
      assert.equal(parsed.senderVpa, '9860123456');
    });
  });

  describe('Fonepay & Nepali Commercial Banks', () => {
    test('parses Fonepay merchant payment received notification', () => {
      const notif = {
        sender: 'Fonepay',
        text: 'Payment of Rs. 350.00 received from Sita Devi via Fonepay. Trace ID: FP987654321',
        timestamp: Date.now()
      };
      const parsed = BankSmsParser.parse(notif);
      assert.ok(parsed);
      assert.equal(parsed.amount, '350.00');
      assert.equal(parsed.amountPaise, 35000n);
      assert.equal(parsed.bankReferenceNumber, 'FP987654321');
    });

    test('parses Nabil Bank SMS with Fonepay credit and NPR currency', () => {
      const sms = {
        sender: 'NABIL_ALERT',
        text: 'Your A/C ...1234 has been credited with NPR 500.00 on 16-Nov-2026 by Fonepay/TRF. Ref: NABIL887766. Avl Bal: NPR 25,000.00',
        timestamp: Date.now()
      };
      const parsed = BankSmsParser.parse(sms);
      assert.ok(parsed);
      assert.equal(parsed.amount, '500.00');
      assert.equal(parsed.amountPaise, 50000n);
      assert.equal(parsed.bankReferenceNumber, 'NABIL887766');
    });

    test('parses NIC Asia MoBank alert with Trace number', () => {
      const sms = {
        sender: 'NIC_ASIA',
        text: 'NIC ASIA: Rs 1500.00 has been credited to your account ...9999 by Fonepay/TRF. Trace: NIC12345678. Avl Bal: Rs 8900.00',
        timestamp: Date.now()
      };
      const parsed = BankSmsParser.parse(sms);
      assert.ok(parsed);
      assert.equal(parsed.amount, '1500.00');
      assert.equal(parsed.amountPaise, 150000n);
      assert.equal(parsed.bankReferenceNumber, 'NIC12345678');
    });

    test('parses Global IME Bank alert with Trace ID', () => {
      const sms = {
        sender: 'GLOBAL_IME',
        text: 'Global IME Bank: A/C *1111 is credited with NPR 250.00 on 16/11/2026. Trace ID: GIME998877. Avl Bal NPR 10000.00',
        timestamp: Date.now()
      };
      const parsed = BankSmsParser.parse(sms);
      assert.ok(parsed);
      assert.equal(parsed.amount, '250.00');
      assert.equal(parsed.amountPaise, 25000n);
      assert.equal(parsed.bankReferenceNumber, 'GIME998877');
    });
  });

  describe('Security and Debit Rejection', () => {
    test('strictly rejects debit and sent money messages', () => {
      const debitSms = {
        sender: 'eSewa',
        text: 'Paid Rs. 500.00 to merchant 9801234567 via eSewa. Txn ID: 999888. Bal: Rs. 2000.00',
        timestamp: Date.now()
      };
      const parsed = BankSmsParser.parse(debitSms);
      assert.equal(parsed, null);
    });
  });

  describe('ObservationNormalizer with Nepali Payloads', () => {
    test('normalizes eSewa notification into canonical observation', () => {
      const normalized = ObservationNormalizer.normalize({
        source: ObserverSource.GOOGLE_MESSAGES,
        receivingAccountId: 'nepal_acc_01',
        rawPayload: {
          notificationText: 'Received Rs. 1000.00 from 9801234567 (Hari). Remarks: Test. Txn ID: ESW1000'
        }
      });
      assert.equal(normalized.amountPaise, 100000n);
      assert.equal(normalized.bankReferenceNumber, 'ESW1000');
      assert.equal(normalized.senderVpa, '9801234567');
      assert.ok(normalized.fingerprintHash);
    });

    test('normalizes Fonepay notification into canonical observation', () => {
      const normalized = ObservationNormalizer.normalize({
        source: ObserverSource.GOOGLE_MESSAGES,
        receivingAccountId: 'nepal_acc_01',
        rawPayload: {
          notificationText: 'Fonepay Alert: Rs. 650.00 credited to account. Ref: FP65000'
        }
      });
      assert.equal(normalized.amountPaise, 65000n);
      assert.equal(normalized.bankReferenceNumber, 'FP65000');
      assert.ok(normalized.fingerprintHash);
    });
  });
});
