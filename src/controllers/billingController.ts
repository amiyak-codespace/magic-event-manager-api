import { Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import pool from '../utils/db';
import { RowDataPacket } from 'mysql2';
import { AuthRequest } from '../middleware/auth';
import { logSecurityActivity, requestIp } from '../utils/security';

interface PlanRow extends RowDataPacket {
  id: string;
  code: string;
  name: string;
  description: string | null;
  price_inr: number;
  interval_months: number;
  features_json: unknown;
  is_active: number;
}

interface PaymentRow extends RowDataPacket {
  id: string;
  user_id: string;
  plan_id: string;
}

const parseFeatures = (v: unknown): unknown => {
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch { return []; }
  }
  return v ?? [];
};

const planWithFeatures = (p: PlanRow) => ({ ...p, features_json: parseFeatures(p.features_json) });

export const getPlans = async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const [rows] = await pool.query<PlanRow[]>('SELECT * FROM subscription_plans ORDER BY price_inr ASC');
    res.json(rows.map(planWithFeatures));
  } catch {
    res.status(500).json({ error: 'Failed to load plans' });
  }
};

export const createPlan = async (req: AuthRequest, res: Response): Promise<void> => {
  const { code, name, description, price_inr, interval_months, features_json, is_active } = req.body || {};
  try {
    if (!code || !name) { res.status(400).json({ error: 'code and name are required' }); return; }
    const id = uuidv4();
    await pool.query(
      `INSERT INTO subscription_plans (id, code, name, description, price_inr, interval_months, features_json, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, String(code).trim().toLowerCase(), name, description || null, Number(price_inr || 0), Number(interval_months || 1), features_json ? JSON.stringify(features_json) : JSON.stringify([]), is_active !== false]
    );
    await logSecurityActivity({
      user_id: req.user!.id,
      email: req.user!.email,
      action: 'admin_plan_created',
      endpoint: req.originalUrl,
      method: req.method,
      success: true,
      ip_address: requestIp(req.headers['x-forwarded-for'], req.socket.remoteAddress),
      user_agent: req.headers['user-agent']?.toString() || null,
      metadata: { code: String(code).trim().toLowerCase(), name },
    });
    const [rows] = await pool.query<PlanRow[]>('SELECT * FROM subscription_plans WHERE id = ?', [id]);
    res.status(201).json(planWithFeatures(rows[0]));
  } catch {
    res.status(500).json({ error: 'Failed to create plan' });
  }
};

export const updatePlan = async (req: AuthRequest, res: Response): Promise<void> => {
  const { name, description, price_inr, interval_months, features_json, is_active } = req.body || {};
  try {
    await pool.query(
      `UPDATE subscription_plans
          SET name = COALESCE(?, name),
              description = COALESCE(?, description),
              price_inr = COALESCE(?, price_inr),
              interval_months = COALESCE(?, interval_months),
              features_json = COALESCE(?, features_json),
              is_active = COALESCE(?, is_active)
        WHERE id = ?`,
      [
        name ?? null,
        description ?? null,
        price_inr ?? null,
        interval_months ?? null,
        features_json === undefined ? null : JSON.stringify(features_json),
        is_active ?? null,
        req.params.id,
      ]
    );
    await logSecurityActivity({
      user_id: req.user!.id,
      email: req.user!.email,
      action: 'admin_plan_updated',
      endpoint: req.originalUrl,
      method: req.method,
      success: true,
      ip_address: requestIp(req.headers['x-forwarded-for'], req.socket.remoteAddress),
      user_agent: req.headers['user-agent']?.toString() || null,
      metadata: { plan_id: req.params.id },
    });
    const [rows] = await pool.query<PlanRow[]>('SELECT * FROM subscription_plans WHERE id = ?', [req.params.id]);
    if (!rows[0]) { res.status(404).json({ error: 'Plan not found' }); return; }
    res.json(planWithFeatures(rows[0]));
  } catch {
    res.status(500).json({ error: 'Failed to update plan' });
  }
};

export const getUsersWithPlans = async (_req: AuthRequest, res: Response): Promise<void> => {
  const q = String(_req.query.q || '').trim().toLowerCase();
  try {
    const where = q ? 'WHERE lower(u.name) LIKE ? OR lower(u.email) LIKE ?' : '';
    const params = q ? [`%${q}%`, `%${q}%`] : [];
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT u.id, u.name, u.email, u.status, u.role, u.created_at,
              s.id AS subscription_id, s.status AS subscription_status, s.started_at, s.expires_at,
              p.id AS plan_id, p.code AS plan_code, p.name AS plan_name, p.price_inr
         FROM users u
    LEFT JOIN user_subscriptions s ON s.user_id = u.id AND s.status = 'active'
    LEFT JOIN subscription_plans p ON p.id = s.plan_id
        ${where}
     ORDER BY u.created_at DESC`,
      params
    );
    res.json(rows);
  } catch {
    res.status(500).json({ error: 'Failed to load users' });
  }
};

export const updateUserBilling = async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.params.id;
  const { status, plan_id } = req.body || {};
  try {
    if (status) {
      await pool.query('UPDATE users SET status = ? WHERE id = ?', [status, userId]);
    }
    if (plan_id) {
      await pool.query('UPDATE user_subscriptions SET status = ? WHERE user_id = ? AND status = ?', ['cancelled', userId, 'active']);
      await pool.query(
        `INSERT INTO user_subscriptions (id, user_id, plan_id, status, started_at, expires_at)
         VALUES (?, ?, ?, 'active', NOW(), DATE_ADD(NOW(), INTERVAL 30 DAY))`,
        [uuidv4(), userId, plan_id]
      );
    }
    await logSecurityActivity({
      user_id: req.user!.id,
      email: req.user!.email,
      action: 'admin_user_billing_updated',
      endpoint: req.originalUrl,
      method: req.method,
      success: true,
      ip_address: requestIp(req.headers['x-forwarded-for'], req.socket.remoteAddress),
      user_agent: req.headers['user-agent']?.toString() || null,
      metadata: { target_user_id: userId, status: status || null, plan_id: plan_id || null },
    });
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: 'Failed to update user billing' });
  }
};

export const getSecurityLogins = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const q = String(req.query.q || '').trim().toLowerCase();
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 100)));
    const params: unknown[] = [];
    const whereParts = [`(l.action LIKE 'login_%' OR l.action LIKE 'oauth_login_success_%')`];
    if (q) {
      whereParts.push('(lower(COALESCE(l.email, u.email)) LIKE ? OR lower(COALESCE(u.name, \'\')) LIKE ?)');
      params.push(`%${q}%`, `%${q}%`);
    }
    const where = `WHERE ${whereParts.join(' AND ')}`;
    params.push(limit);
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT l.id, l.user_id, COALESCE(l.email, u.email) AS email, u.name,
              l.action, l.success, l.ip_address, l.user_agent, l.endpoint, l.method, l.created_at
         FROM security_activity_logs l
    LEFT JOIN users u ON u.id = l.user_id
        ${where}
     ORDER BY l.created_at DESC
        LIMIT ?`,
      params
    );
    res.json(rows);
  } catch {
    res.status(500).json({ error: 'Failed to load security logs' });
  }
};

export const getPublicPlans = async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const [rows] = await pool.query<PlanRow[]>('SELECT * FROM subscription_plans WHERE is_active = TRUE ORDER BY price_inr ASC');
    res.json(rows.map(planWithFeatures));
  } catch {
    res.status(500).json({ error: 'Failed to load plans' });
  }
};

export const getMySubscription = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT s.id AS subscription_id, s.status AS subscription_status, s.started_at, s.expires_at,
              p.id AS plan_id, p.code AS plan_code, p.name AS plan_name, p.price_inr
         FROM user_subscriptions s
         JOIN subscription_plans p ON p.id = s.plan_id
        WHERE s.user_id = ? AND s.status = 'active'
        ORDER BY s.created_at DESC
        LIMIT 1`,
      [req.user!.id]
    );
    res.json(rows[0] || null);
  } catch {
    res.status(500).json({ error: 'Failed to load subscription' });
  }
};

export const createCheckoutOrder = async (req: AuthRequest, res: Response): Promise<void> => {
  const { plan_code } = req.body || {};
  try {
    if (!plan_code) { res.status(400).json({ error: 'plan_code is required' }); return; }
    const [plans] = await pool.query<PlanRow[]>(
      'SELECT * FROM subscription_plans WHERE code = ? AND is_active = TRUE LIMIT 1',
      [String(plan_code).trim().toLowerCase()]
    );
    const plan = plans[0];
    if (!plan) { res.status(404).json({ error: 'Plan not found' }); return; }

    const localOrderId = uuidv4();
    const amountPaise = Number(plan.price_inr) * 100;
    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    let providerOrderId = `mock_order_${localOrderId}`;

    if (Number(plan.price_inr) > 0 && keyId && keySecret) {
      const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
      const orderResp = await fetch('https://api.razorpay.com/v1/orders', {
        method: 'POST',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount: amountPaise,
          currency: 'INR',
          receipt: localOrderId.slice(0, 36),
          notes: { user_id: req.user!.id, plan_code: plan.code },
        }),
      });
      const orderData = await orderResp.json() as { id?: string; error?: { description?: string } };
      if (!orderResp.ok || !orderData.id) {
        res.status(400).json({ error: orderData?.error?.description || 'Failed to create payment order' });
        return;
      }
      providerOrderId = orderData.id;
    }

    await pool.query(
      `INSERT INTO subscription_payments (id, user_id, plan_id, provider_order_id, amount_inr, currency, status, payload_json)
       VALUES (?, ?, ?, ?, ?, 'INR', 'created', ?)`,
      [localOrderId, req.user!.id, plan.id, providerOrderId, Number(plan.price_inr), JSON.stringify({ plan_code: plan.code })]
    );

    res.json({
      local_order_id: localOrderId,
      order_id: providerOrderId,
      amount: amountPaise,
      currency: 'INR',
      key: keyId || '',
      mock: !(Number(plan.price_inr) > 0 && keyId && keySecret),
      plan: planWithFeatures(plan),
    });
  } catch {
    res.status(500).json({ error: 'Failed to start checkout' });
  }
};

export const verifyCheckout = async (req: AuthRequest, res: Response): Promise<void> => {
  const { local_order_id, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
  try {
    if (!local_order_id || !razorpay_order_id || !razorpay_payment_id) {
      res.status(400).json({ error: 'Missing payment fields' });
      return;
    }
    const [rows] = await pool.query<PaymentRow[]>('SELECT * FROM subscription_payments WHERE id = ? LIMIT 1', [local_order_id]);
    const order = rows[0];
    if (!order || order.user_id !== req.user!.id) { res.status(404).json({ error: 'Order not found' }); return; }

    let verified = false;
    const secret = process.env.RAZORPAY_KEY_SECRET;
    if (secret && razorpay_signature) {
      const expected = crypto.createHmac('sha256', secret).update(`${razorpay_order_id}|${razorpay_payment_id}`).digest('hex');
      verified = expected === razorpay_signature;
    } else if (String(razorpay_order_id).startsWith('mock_order_')) {
      verified = true;
    }
    if (!verified) { res.status(400).json({ error: 'Signature verification failed' }); return; }

    await pool.query(
      `UPDATE subscription_payments
          SET provider_order_id = ?, provider_payment_id = ?, status = 'paid', signature_verified = TRUE
        WHERE id = ?`,
      [razorpay_order_id, razorpay_payment_id, local_order_id]
    );
    await pool.query('UPDATE user_subscriptions SET status = ? WHERE user_id = ? AND status = ?', ['cancelled', req.user!.id, 'active']);
    await pool.query(
      `INSERT INTO user_subscriptions (id, user_id, plan_id, status, started_at, expires_at)
       VALUES (?, ?, ?, 'active', NOW(), DATE_ADD(NOW(), INTERVAL 30 DAY))`,
      [uuidv4(), req.user!.id, order.plan_id]
    );
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: 'Failed to verify payment' });
  }
};
