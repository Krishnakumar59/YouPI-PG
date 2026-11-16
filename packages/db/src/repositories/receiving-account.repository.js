import crypto from 'node:crypto';

export class ReceivingAccountRepository {
  /**
   * @param {import('../database.js').Database} db
   */
  constructor(db) {
    this.db = db;
  }

  /**
   * Creates a new receiving UPI account.
   * If isActive is true, atomically deactivates any other active accounts for this merchant.
   * Enforces that maximum ONE VPA may be active per merchant.
   */
  create(data) {
    const id = data.id || crypto.randomUUID();
    const now = new Date().toISOString();
    const isActive = data.isActive !== undefined ? Boolean(data.isActive) : true;
    const isMerchantEnabled = data.isMerchantEnabled !== undefined ? Boolean(data.isMerchantEnabled) : true;
    const dailyTransactionLimit = data.dailyTransactionLimit !== undefined && data.dailyTransactionLimit !== null
      ? Number(data.dailyTransactionLimit)
      : 50;
    const priority = data.priority !== undefined && data.priority !== null ? Number(data.priority) : 0;
    const customQrString = data.customQrString ? String(data.customQrString).trim() : null;

    return this.db.transaction(() => {
      // If this new account is marked active, atomically deactivate all existing active accounts for this merchant
      if (isActive) {
        this.db.execute(`
          UPDATE payment_receiving_accounts
          SET is_active = 0, updated_at = ?
          WHERE merchant_id = ?
        `, [now, data.merchantId]);
      }

      const sql = `
        INSERT INTO payment_receiving_accounts (
          id, merchant_id, upi_id, payee_name, is_merchant_enabled,
          is_active, is_slot_busy, current_active_session_id,
          daily_transaction_limit, priority, custom_qr_string,
          created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;

      this.db.execute(sql, [
        id,
        data.merchantId,
        data.upiId.trim(),
        data.payeeName.trim(),
        isMerchantEnabled ? 1 : 0,
        isActive ? 1 : 0,
        0,
        null,
        dailyTransactionLimit,
        priority,
        customQrString,
        now,
        now
      ]);

      return this.findById(id);
    });
  }

  findById(id) {
    const row = this.db.queryOne('SELECT * FROM payment_receiving_accounts WHERE id = ?', [id]);
    if (!row) return null;
    return this.mapRow(row);
  }

  findByMerchantId(merchantId) {
    const rows = this.db.query(
      'SELECT * FROM payment_receiving_accounts WHERE merchant_id = ? ORDER BY is_active DESC, created_at ASC',
      [merchantId]
    );
    return rows.map(r => this.mapRow(r));
  }

  findActiveForMerchant(merchantId, options = {}) {
    if (options && options.autoRotate) {
      return this.findOrRotateActiveAccount(merchantId, options);
    }
    const row = this.db.queryOne(
      'SELECT * FROM payment_receiving_accounts WHERE merchant_id = ? AND is_active = 1 LIMIT 1',
      [merchantId]
    );
    if (!row) return null;
    return this.mapRow(row);
  }

  /**
   * Counts the number of successful/completed transactions today for a specific receiving account.
   * @param {string} accountId
   * @param {Date|string} [date]
   * @returns {number}
   */
  getTodayCompletedCount(accountId, date = new Date()) {
    const dateStr = typeof date === 'string' ? date.slice(0, 10) : date.toISOString().slice(0, 10);
    const row = this.db.queryOne(`
      SELECT COUNT(*) as count 
      FROM payment_sessions 
      WHERE receiving_account_id = ? 
        AND status IN ('SUCCESS', 'OBSERVED_SUCCESS', 'RECONCILED') 
        AND date(COALESCE(completed_at, updated_at)) = ?
    `, [accountId, dateStr]);
    return Number(row?.count || 0);
  }

  /**
   * Returns daily limit details and exhaustion status for an account.
   * @param {string} accountId
   * @param {Date|string} [date]
   * @returns {{ limit: number, completedToday: number, remaining: number, isExhausted: boolean } | null}
   */
  getAccountLimitStatus(accountId, date = new Date()) {
    const account = this.findById(accountId);
    if (!account) return null;
    const completedToday = this.getTodayCompletedCount(accountId, date);
    const limit = account.dailyTransactionLimit;
    const remaining = limit > 0 ? Math.max(0, limit - completedToday) : Infinity;
    return {
      limit,
      completedToday,
      remaining,
      isExhausted: limit > 0 && completedToday >= limit
    };
  }

  /**
   * Finds the currently active receiving account for a merchant.
   * If the active account has reached its daily transaction limit (e.g. 50 payments/day for personal wallets),
   * this automatically and atomically switches to the next available account in the merchant's pool
   * ordered by priority DESC, created_at ASC that still has capacity today.
   *
   * @param {string} merchantId
   * @param {{ date?: Date|string, forceCheck?: boolean }} [options]
   * @returns {object|null}
   */
  findOrRotateActiveAccount(merchantId, options = {}) {
    return this.db.transaction(() => {
      const active = this.findActiveForMerchant(merchantId);
      const date = options.date || new Date();

      if (active) {
        // If limit is 0, account has unlimited daily transactions
        const isExhausted = active.dailyTransactionLimit > 0 &&
          this.getTodayCompletedCount(active.id, date) >= active.dailyTransactionLimit;

        if (!isExhausted) {
          return active;
        }

        // Active account is exhausted. Search for a replacement candidate.
        const candidates = this.db.query(`
          SELECT * FROM payment_receiving_accounts 
          WHERE merchant_id = ? AND is_merchant_enabled = 1 AND id != ?
          ORDER BY priority DESC, created_at ASC
        `, [merchantId, active.id]).map(r => this.mapRow(r));

        for (const candidate of candidates) {
          const candidateCompleted = this.getTodayCompletedCount(candidate.id, date);
          if (candidate.dailyTransactionLimit === 0 || candidateCompleted < candidate.dailyTransactionLimit) {
            // Found a candidate with remaining capacity! Activate it atomically.
            this.activateAccount(merchantId, candidate.id);
            return this.findById(candidate.id);
          }
        }

        // All configured accounts have reached their daily limit!
        // Return active account as fallback (do not throw or crash checkout).
        return active;
      }

      // No active account exists. Find the highest priority enabled account with capacity.
      const candidates = this.db.query(`
        SELECT * FROM payment_receiving_accounts 
        WHERE merchant_id = ? AND is_merchant_enabled = 1
        ORDER BY priority DESC, created_at ASC
      `, [merchantId]).map(r => this.mapRow(r));

      for (const candidate of candidates) {
        const candidateCompleted = this.getTodayCompletedCount(candidate.id, date);
        if (candidate.dailyTransactionLimit === 0 || candidateCompleted < candidate.dailyTransactionLimit) {
          this.activateAccount(merchantId, candidate.id);
          return this.findById(candidate.id);
        }
      }

      return candidates.length > 0 ? candidates[0] : null;
    });
  }

  /**
   * Atomically activates an account and deactivates all other accounts for this merchant.
   * Backend invariant: At most ONE VPA active per merchant.
   */
  activateAccount(merchantId, accountId) {
    return this.db.transaction(() => {
      const now = new Date().toISOString();

      // Deactivate all existing accounts for this merchant
      this.db.execute(`
        UPDATE payment_receiving_accounts
        SET is_active = 0, updated_at = ?
        WHERE merchant_id = ?
      `, [now, merchantId]);

      // Activate the targeted account
      this.db.execute(`
        UPDATE payment_receiving_accounts
        SET is_active = 1, updated_at = ?
        WHERE id = ? AND merchant_id = ?
      `, [now, accountId, merchantId]);

      return this.findById(accountId);
    });
  }

  /**
   * Deactivates a specific account.
   */
  deactivateAccount(merchantId, accountId) {
    const now = new Date().toISOString();
    this.db.execute(`
      UPDATE payment_receiving_accounts
      SET is_active = 0, updated_at = ?
      WHERE id = ? AND merchant_id = ?
    `, [now, accountId, merchantId]);

    return this.findById(accountId);
  }

  /**
   * Updates an existing account's details.
   */
  updateAccount(id, data) {
    return this.db.transaction(() => {
      const existing = this.findById(id);
      if (!existing) return null;

      const now = new Date().toISOString();
      const upiId = data.upiId !== undefined ? data.upiId.trim() : existing.upiId;

      if (existing.isSlotBusy && data.upiId !== undefined && upiId !== existing.upiId) {
        throw new Error('Cannot change UPI ID while receiving account slot is currently busy with an active payment session.');
      }

      const payeeName = data.payeeName !== undefined ? data.payeeName.trim() : existing.payeeName;
      const isMerchantEnabled = data.isMerchantEnabled !== undefined ? Boolean(data.isMerchantEnabled) : existing.isMerchantEnabled;
      const dailyTransactionLimit = data.dailyTransactionLimit !== undefined && data.dailyTransactionLimit !== null
        ? Number(data.dailyTransactionLimit)
        : existing.dailyTransactionLimit;
      const priority = data.priority !== undefined && data.priority !== null
        ? Number(data.priority)
        : existing.priority;
      const customQrString = data.customQrString !== undefined
        ? (data.customQrString ? String(data.customQrString).trim() : null)
        : existing.customQrString;

      if (data.isActive === true) {
        this.db.execute(`
          UPDATE payment_receiving_accounts
          SET is_active = 0, updated_at = ?
          WHERE merchant_id = ?
        `, [now, existing.merchantId]);

        this.db.execute(`
          UPDATE payment_receiving_accounts
          SET upi_id = ?, payee_name = ?, is_merchant_enabled = ?, is_active = 1,
              daily_transaction_limit = ?, priority = ?, custom_qr_string = ?, updated_at = ?
          WHERE id = ?
        `, [upiId, payeeName, isMerchantEnabled ? 1 : 0, dailyTransactionLimit, priority, customQrString, now, id]);
      } else if (data.isActive === false) {
        this.db.execute(`
          UPDATE payment_receiving_accounts
          SET upi_id = ?, payee_name = ?, is_merchant_enabled = ?, is_active = 0,
              daily_transaction_limit = ?, priority = ?, custom_qr_string = ?, updated_at = ?
          WHERE id = ?
        `, [upiId, payeeName, isMerchantEnabled ? 1 : 0, dailyTransactionLimit, priority, customQrString, now, id]);
      } else {
        this.db.execute(`
          UPDATE payment_receiving_accounts
          SET upi_id = ?, payee_name = ?, is_merchant_enabled = ?,
              daily_transaction_limit = ?, priority = ?, custom_qr_string = ?, updated_at = ?
          WHERE id = ?
        `, [upiId, payeeName, isMerchantEnabled ? 1 : 0, dailyTransactionLimit, priority, customQrString, now, id]);
      }

      return this.findById(id);
    });
  }

  /**
   * Deletes a receiving account.
   * Throws if the slot is currently busy.
   */
  deleteAccount(merchantId, accountId) {
    const account = this.findById(accountId);
    if (!account || account.merchantId !== merchantId) {
      throw new Error(`Account not found or does not belong to merchant: ${accountId}`);
    }

    if (account.isSlotBusy || account.currentActiveSessionId) {
      throw new Error(`Cannot delete account ${account.upiId} because it has an active checkout session.`);
    }

    this.db.execute('DELETE FROM payment_receiving_accounts WHERE id = ? AND merchant_id = ?', [accountId, merchantId]);
    return true;
  }

  /**
   * Sets slot busy status and currently active session ID.
   */
  setSlotStatus(id, isBusy, activeSessionId = null) {
    const now = new Date().toISOString();
    this.db.execute(`
      UPDATE payment_receiving_accounts
      SET is_slot_busy = ?, current_active_session_id = ?, updated_at = ?
      WHERE id = ?
    `, [isBusy ? 1 : 0, activeSessionId, now, id]);

    return this.findById(id);
  }

  /**
   * Updates or creates the active receiving UPI account for a merchant.
   * @param {string} merchantId
   * @param {string} upiId
   * @param {string} [payeeName]
   * @param {boolean} [isMerchantEnabled=true]
   */
  upsertActiveForMerchant(merchantId, upiId, payeeName = null, isMerchantEnabled = true) {
    const cleanUpi = upiId.trim();
    const existing = this.findActiveForMerchant(merchantId);
    const now = new Date().toISOString();

    if (existing) {
      this.db.execute(`
        UPDATE payment_receiving_accounts
        SET upi_id = ?, payee_name = COALESCE(?, payee_name), is_merchant_enabled = ?, updated_at = ?
        WHERE id = ?
      `, [cleanUpi, payeeName?.trim() || null, isMerchantEnabled ? 1 : 0, now, existing.id]);
      return this.findById(existing.id);
    } else {
      return this.create({
        merchantId,
        upiId: cleanUpi,
        payeeName: payeeName?.trim() || 'Merchant Store',
        isMerchantEnabled,
        isActive: true
      });
    }
  }

  mapRow(row) {
    return {
      id: row.id,
      merchantId: row.merchant_id,
      upiId: row.upi_id,
      payeeName: row.payee_name,
      isMerchantEnabled: Boolean(row.is_merchant_enabled !== undefined ? row.is_merchant_enabled : 1),
      isActive: Boolean(row.is_active),
      isSlotBusy: Boolean(row.is_slot_busy),
      currentActiveSessionId: row.current_active_session_id,
      dailyTransactionLimit: Number(row.daily_transaction_limit !== undefined && row.daily_transaction_limit !== null ? row.daily_transaction_limit : 50),
      priority: Number(row.priority !== undefined && row.priority !== null ? row.priority : 0),
      customQrString: row.custom_qr_string || null,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at)
    };
  }
}
