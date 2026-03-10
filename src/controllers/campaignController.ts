import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import pool from '../utils/db';
import { RowDataPacket } from 'mysql2';
import { AuthRequest } from '../middleware/auth';
import { sendEmail, eventInviteTemplate } from '../utils/emailService';
import jwt from 'jsonwebtoken';

const GEMINI_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';

type CampaignType = 'email' | 'whatsapp' | 'sms';

type InputRecipient = {
  name?: string;
  email?: string;
  phone?: string;
  consent_opted_in?: boolean | string;
  consent_source?: string;
  validation_score?: number;
  validation_issues?: string[];
};

type RecipientRow = RowDataPacket & {
  id: number;
  recipient_name: string | null;
  recipient_email: string | null;
  recipient_phone: string | null;
  consent_opted_in: number | null;
  consent_source: string | null;
  consent_captured_at: string | null;
  source: 'registered' | 'csv';
  status: 'pending' | 'sent' | 'failed';
  validation_score: number | null;
  validation_issues: string | null;
};

type ParsedRecipient = {
  name?: string;
  email?: string;
  phone?: string;
  consent_opted_in?: boolean;
  consent_source?: string;
  validation_score: number;
  validation_issues: string[];
  valid: boolean;
};

let campaignRecipientsColumnsCache: Set<string> | null = null;
let rsvpColumnsCache: Set<string> | null = null;
let campaignSendWorkerActive = false;

type ContentModeration = {
  safe: boolean;
  risk_score: number;
  reasons: string[];
  suggestion?: string;
  provider: 'gemini' | 'heuristic';
};

function parseConsentValue(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  const s = String(value || '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'y', 'opted_in', 'opt-in'].includes(s);
}

function sanitizePhone(phone?: string): string | null {
  if (!phone) return null;
  const digits = phone.replace(/[^0-9]/g, '');
  if (digits.length < 8) return null;
  return digits;
}

function sanitizeEmail(email?: string): string | null {
  if (!email) return null;
  const out = email.trim().toLowerCase();
  return /.+@.+\..+/.test(out) ? out : null;
}

function toScoredRecipient(input: InputRecipient): ParsedRecipient {
  const issues: string[] = [];
  const email = sanitizeEmail(input.email);
  const phone = sanitizePhone(input.phone);
  const name = input.name?.trim() || '';
  let score = 100;
  if (!email && !phone) {
    issues.push('Missing email or phone');
    score -= 70;
  }
  if (input.email && !email) {
    issues.push('Invalid email format');
    score -= 35;
  }
  if (input.phone && !phone) {
    issues.push('Invalid phone format');
    score -= 35;
  }
  if (!name) score -= 10;
  score = Math.max(0, Math.min(100, score));
  return {
    name: name || undefined,
    email: email || undefined,
    phone: phone || undefined,
    validation_score: score,
    validation_issues: issues,
    valid: !!(email || phone),
  };
}

function parseCsvOrTextFallback(input: string): ParsedRecipient[] {
  const lines = input.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const hasCsvHeader = /name|email|phone|mobile/i.test(lines[0]) && lines[0].includes(',');
  const out: ParsedRecipient[] = [];

  if (hasCsvHeader) {
    const cols = lines[0].split(',').map((c) => c.trim().toLowerCase());
    const nameIdx = cols.findIndex((c) => c === 'name');
    const emailIdx = cols.findIndex((c) => c === 'email');
    const phoneIdx = cols.findIndex((c) => c === 'phone' || c === 'mobile');
    const consentIdx = cols.findIndex((c) => c === 'consent' || c === 'opted_in' || c === 'marketing_opt_in');
    const consentSourceIdx = cols.findIndex((c) => c === 'consent_source');
    for (const row of lines.slice(1)) {
      const parts = row.split(',').map((p) => p.trim());
      const scored = toScoredRecipient({
        name: nameIdx >= 0 ? parts[nameIdx] : undefined,
        email: emailIdx >= 0 ? parts[emailIdx] : undefined,
        phone: phoneIdx >= 0 ? parts[phoneIdx] : undefined,
      });
      scored.consent_opted_in = consentIdx >= 0 ? parseConsentValue(parts[consentIdx]) : false;
      scored.consent_source = consentSourceIdx >= 0 ? (parts[consentSourceIdx] || undefined) : undefined;
      out.push(scored);
    }
    return out;
  }

  for (const line of lines) {
    const emailMatch = line.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    const phoneMatch = line.match(/(?:\+?\d[\d\s\-()]{7,}\d)/);
    const cleaned = line
      .replace(emailMatch?.[0] || '', '')
      .replace(phoneMatch?.[0] || '', '')
      .replace(/[,\-|]/g, ' ')
      .trim();
    out.push(toScoredRecipient({
      name: cleaned || undefined,
      email: emailMatch?.[0],
      phone: phoneMatch?.[0],
    }));
  }
  return out;
}

function dedupeRecipients(items: Array<{ name?: string | null; email?: string | null; phone?: string | null; source: 'registered' | 'csv'; consent_opted_in?: boolean; consent_source?: string | null }>) {
  const map = new Map<string, { name?: string | null; email?: string | null; phone?: string | null; source: 'registered' | 'csv'; consent_opted_in?: boolean; consent_source?: string | null }>();
  for (const item of items) {
    const email = sanitizeEmail(item.email || undefined);
    const phone = sanitizePhone(item.phone || undefined);
    if (!email && !phone) continue;
    const key = `${email || ''}|${phone || ''}`;
    if (!map.has(key)) {
      map.set(key, { ...item, email, phone });
    } else {
      const existing = map.get(key)!;
      map.set(key, {
        ...existing,
        consent_opted_in: !!(existing.consent_opted_in || item.consent_opted_in),
        consent_source: existing.consent_source || item.consent_source || null,
      });
    }
  }
  return Array.from(map.values());
}

async function ensureCampaignRecipientsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS campaign_recipients (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      campaign_id VARCHAR(36) NOT NULL,
      recipient_name VARCHAR(255),
      recipient_email VARCHAR(255),
      recipient_phone VARCHAR(30),
      consent_opted_in BOOLEAN DEFAULT FALSE,
      consent_source VARCHAR(80),
      consent_captured_at DATETIME NULL,
      source ENUM('registered','csv') DEFAULT 'registered',
      status ENUM('pending','sent','failed') DEFAULT 'pending',
      validation_score INT DEFAULT 100,
      validation_issues TEXT,
      error_message TEXT,
      sent_at DATETIME NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_campaign (campaign_id),
      FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  const [rows] = await pool.query<RowDataPacket[]>(
    `
      SELECT COLUMN_NAME
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'campaign_recipients'
    `
  );

  const existing = new Set(rows.map((r) => String(r.COLUMN_NAME)));
  campaignRecipientsColumnsCache = new Set(existing);
  const alterStatements: string[] = [];

  if (!existing.has('recipient_name')) {
    alterStatements.push('ALTER TABLE campaign_recipients ADD COLUMN recipient_name VARCHAR(255) NULL');
  }
  if (!existing.has('recipient_email')) {
    alterStatements.push('ALTER TABLE campaign_recipients ADD COLUMN recipient_email VARCHAR(255) NULL');
  }
  if (!existing.has('recipient_phone')) {
    alterStatements.push('ALTER TABLE campaign_recipients ADD COLUMN recipient_phone VARCHAR(30) NULL');
  }
  if (!existing.has('consent_opted_in')) {
    alterStatements.push('ALTER TABLE campaign_recipients ADD COLUMN consent_opted_in BOOLEAN DEFAULT FALSE');
  }
  if (!existing.has('consent_source')) {
    alterStatements.push('ALTER TABLE campaign_recipients ADD COLUMN consent_source VARCHAR(80) NULL');
  }
  if (!existing.has('consent_captured_at')) {
    alterStatements.push('ALTER TABLE campaign_recipients ADD COLUMN consent_captured_at DATETIME NULL');
  }
  if (!existing.has('source')) {
    alterStatements.push("ALTER TABLE campaign_recipients ADD COLUMN source ENUM('registered','csv') DEFAULT 'registered'");
  }
  if (!existing.has('status')) {
    alterStatements.push("ALTER TABLE campaign_recipients ADD COLUMN status ENUM('pending','sent','failed') DEFAULT 'pending'");
  }
  if (!existing.has('validation_score')) {
    alterStatements.push('ALTER TABLE campaign_recipients ADD COLUMN validation_score INT DEFAULT 100');
  }
  if (!existing.has('validation_issues')) {
    alterStatements.push('ALTER TABLE campaign_recipients ADD COLUMN validation_issues TEXT');
  }
  if (!existing.has('error_message')) {
    alterStatements.push('ALTER TABLE campaign_recipients ADD COLUMN error_message TEXT');
  }
  if (!existing.has('sent_at')) {
    alterStatements.push('ALTER TABLE campaign_recipients ADD COLUMN sent_at DATETIME NULL');
  }
  if (!existing.has('created_at')) {
    alterStatements.push('ALTER TABLE campaign_recipients ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP');
  }
  if (!existing.has('campaign_id')) {
    alterStatements.push('ALTER TABLE campaign_recipients ADD COLUMN campaign_id VARCHAR(36) NOT NULL');
  }

  for (const sql of alterStatements) {
    await pool.query(sql);
  }
  for (const sql of alterStatements) {
    const m = sql.match(/ADD COLUMN\s+([a-zA-Z0-9_]+)/i);
    if (m && campaignRecipientsColumnsCache) campaignRecipientsColumnsCache.add(m[1]);
  }
}

async function ensureEmailUnsubscribesTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS email_unsubscribes (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      email VARCHAR(255) NOT NULL UNIQUE,
      source VARCHAR(80) DEFAULT 'unsubscribe_link',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

function buildUnsubscribeToken(email: string, campaignId: string): string {
  return jwt.sign(
    { email: email.trim().toLowerCase(), campaign_id: campaignId, type: 'campaign_unsub' },
    process.env.JWT_SECRET!,
    { expiresIn: '365d' }
  );
}

function buildUnsubscribeUrl(email: string, campaignId: string): string {
  const apiBase = process.env.API_BASE_URL || 'https://events.appsmagic.in';
  const token = buildUnsubscribeToken(email, campaignId);
  return `${apiBase}/api/campaigns/unsubscribe?token=${encodeURIComponent(token)}`;
}

async function isEmailUnsubscribed(email: string): Promise<boolean> {
  await ensureEmailUnsubscribesTable();
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT id FROM email_unsubscribes WHERE email = ? LIMIT 1',
    [email.trim().toLowerCase()]
  );
  return rows.length > 0;
}

async function campaignRecipientsHasColumn(name: string): Promise<boolean> {
  if (campaignRecipientsColumnsCache) return campaignRecipientsColumnsCache.has(name);
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'campaign_recipients'`
  );
  campaignRecipientsColumnsCache = new Set(rows.map((r) => String(r.COLUMN_NAME)));
  return campaignRecipientsColumnsCache.has(name);
}

async function insertCampaignRecipient(input: {
  campaignId: string;
  recipientName: string | null;
  recipientEmail: string | null;
  recipientPhone: string | null;
  consentOptedIn: boolean;
  consentSource: string | null;
  source: 'registered' | 'csv';
  validationScore: number;
  validationIssuesJson: string | null;
}) {
  const hasLegacyContact = await campaignRecipientsHasColumn('contact');
  const withIdSql = hasLegacyContact
    ? `INSERT INTO campaign_recipients (id, campaign_id, contact, recipient_name, recipient_email, recipient_phone, consent_opted_in, consent_source, consent_captured_at, source, validation_score, validation_issues)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?, ?)`
    : `INSERT INTO campaign_recipients (id, campaign_id, recipient_name, recipient_email, recipient_phone, consent_opted_in, consent_source, consent_captured_at, source, validation_score, validation_issues)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?, ?)`;
  const withIdValues = hasLegacyContact
    ? [
        uuidv4(),
        input.campaignId,
        input.recipientEmail || input.recipientPhone || '',
        input.recipientName,
        input.recipientEmail,
        input.recipientPhone,
        parseConsentValue(input.consentOptedIn),
        input.consentSource,
        input.source,
        input.validationScore,
        input.validationIssuesJson,
      ]
    : [
        uuidv4(),
        input.campaignId,
        input.recipientName,
        input.recipientEmail,
        input.recipientPhone,
        parseConsentValue(input.consentOptedIn),
        input.consentSource,
        input.source,
        input.validationScore,
        input.validationIssuesJson,
      ];

  try {
    await pool.query(withIdSql, withIdValues);
    return;
  } catch (err) {
    const m = String((err as { message?: string }).message || '');
    const code = String((err as { code?: string }).code || '');
    const canRetryWithoutId =
      code === 'ER_TRUNCATED_WRONG_VALUE' ||
      m.includes('Incorrect integer value') ||
      m.includes('Data truncated');
    if (!canRetryWithoutId) throw err;
  }

  if (hasLegacyContact) {
    await pool.query(
      `INSERT INTO campaign_recipients (campaign_id, contact, recipient_name, recipient_email, recipient_phone, consent_opted_in, consent_source, consent_captured_at, source, validation_score, validation_issues)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?, ?)`,
      [
        input.campaignId,
        input.recipientEmail || input.recipientPhone || '',
        input.recipientName,
        input.recipientEmail,
        input.recipientPhone,
        parseConsentValue(input.consentOptedIn),
        input.consentSource,
        input.source,
        input.validationScore,
        input.validationIssuesJson,
      ]
    );
  } else {
    await pool.query(
      `INSERT INTO campaign_recipients (campaign_id, recipient_name, recipient_email, recipient_phone, consent_opted_in, consent_source, consent_captured_at, source, validation_score, validation_issues)
       VALUES (?, ?, ?, ?, ?, ?, NOW(), ?, ?, ?)`,
      [
        input.campaignId,
        input.recipientName,
        input.recipientEmail,
        input.recipientPhone,
        parseConsentValue(input.consentOptedIn),
        input.consentSource,
        input.source,
        input.validationScore,
        input.validationIssuesJson,
      ]
    );
  }
}

async function ensureCampaignEnterpriseColumns() {
  const [rows] = await pool.query<RowDataPacket[]>(
    `
      SELECT COLUMN_NAME
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'campaigns'
        AND COLUMN_NAME IN ('priority', 'tags', 'send_window_start', 'send_window_end', 'max_per_minute', 'compliance_confirmed', 'compliance_notes')
    `
  );

  const existing = new Set(rows.map((r) => String(r.COLUMN_NAME)));
  const alterStatements: string[] = [];

  if (!existing.has('priority')) {
    alterStatements.push("ALTER TABLE campaigns ADD COLUMN priority ENUM('low','normal','high') DEFAULT 'normal'");
  }
  if (!existing.has('tags')) {
    alterStatements.push('ALTER TABLE campaigns ADD COLUMN tags VARCHAR(255) NULL');
  }
  if (!existing.has('send_window_start')) {
    alterStatements.push('ALTER TABLE campaigns ADD COLUMN send_window_start VARCHAR(5) NULL');
  }
  if (!existing.has('send_window_end')) {
    alterStatements.push('ALTER TABLE campaigns ADD COLUMN send_window_end VARCHAR(5) NULL');
  }
  if (!existing.has('max_per_minute')) {
    alterStatements.push('ALTER TABLE campaigns ADD COLUMN max_per_minute INT DEFAULT 120');
  }
  if (!existing.has('compliance_confirmed')) {
    alterStatements.push('ALTER TABLE campaigns ADD COLUMN compliance_confirmed BOOLEAN DEFAULT FALSE');
  }
  if (!existing.has('compliance_notes')) {
    alterStatements.push('ALTER TABLE campaigns ADD COLUMN compliance_notes TEXT NULL');
  }

  for (const sql of alterStatements) {
    await pool.query(sql);
  }
}

async function ensureCampaignAuditTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS campaign_audit_logs (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      campaign_id VARCHAR(36) NULL,
      organizer_id VARCHAR(36) NOT NULL,
      action VARCHAR(64) NOT NULL,
      channel VARCHAR(20) NULL,
      severity ENUM('info','warn','error') DEFAULT 'info',
      details_json LONGTEXT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_campaign (campaign_id),
      INDEX idx_organizer (organizer_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  const [columns] = await pool.query<RowDataPacket[]>('SHOW COLUMNS FROM campaign_audit_logs');
  const existing = new Set(columns.map((c) => String(c.Field || '')));
  const alterStatements: string[] = [];

  if (!existing.has('campaign_id')) {
    alterStatements.push('ALTER TABLE campaign_audit_logs ADD COLUMN campaign_id VARCHAR(36) NULL AFTER id');
  }
  if (!existing.has('organizer_id')) {
    alterStatements.push('ALTER TABLE campaign_audit_logs ADD COLUMN organizer_id VARCHAR(36) NOT NULL AFTER campaign_id');
  }
  if (!existing.has('action')) {
    alterStatements.push('ALTER TABLE campaign_audit_logs ADD COLUMN action VARCHAR(64) NOT NULL AFTER organizer_id');
  }
  if (!existing.has('channel')) {
    alterStatements.push('ALTER TABLE campaign_audit_logs ADD COLUMN channel VARCHAR(20) NULL AFTER action');
  }
  if (!existing.has('severity')) {
    alterStatements.push("ALTER TABLE campaign_audit_logs ADD COLUMN severity ENUM('info','warn','error') DEFAULT 'info' AFTER channel");
  }
  if (!existing.has('details_json')) {
    alterStatements.push('ALTER TABLE campaign_audit_logs ADD COLUMN details_json LONGTEXT NULL AFTER severity');
  }
  if (!existing.has('created_at')) {
    alterStatements.push('ALTER TABLE campaign_audit_logs ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP');
  }

  for (const sql of alterStatements) {
    await pool.query(sql);
  }

  try {
    await pool.query('CREATE INDEX idx_campaign ON campaign_audit_logs (campaign_id)');
  } catch {}
  try {
    await pool.query('CREATE INDEX idx_organizer ON campaign_audit_logs (organizer_id)');
  } catch {}
}

async function auditCampaignAction(input: {
  campaign_id?: string | null;
  organizer_id: string;
  action: string;
  channel?: string | null;
  severity?: 'info' | 'warn' | 'error';
  details?: unknown;
}) {
  await ensureCampaignAuditTable();
  await pool.query(
    `INSERT INTO campaign_audit_logs (campaign_id, organizer_id, action, channel, severity, details_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      input.campaign_id || null,
      input.organizer_id,
      input.action,
      input.channel || null,
      input.severity || 'info',
      input.details ? JSON.stringify(input.details) : null,
    ]
  );
}

function inSendWindow(start?: string | null, end?: string | null): boolean {
  if (!start || !end) return true;
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const cur = `${hh}:${mm}`;
  if (start <= end) return cur >= start && cur <= end;
  return cur >= start || cur <= end;
}

async function ensureRuntimeFlagsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_runtime_flags (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      flag_key VARCHAR(100) NOT NULL UNIQUE,
      flag_value VARCHAR(100) NOT NULL,
      updated_by VARCHAR(36) NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

async function isCampaignServiceDisabled(): Promise<boolean> {
  if (String(process.env.CAMPAIGN_SERVICE_DISABLED || '').toLowerCase() === 'true') {
    return true;
  }
  await ensureRuntimeFlagsTable();
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT flag_value FROM app_runtime_flags WHERE flag_key = ? LIMIT 1',
    ['campaign_service_disabled']
  );
  if (!rows.length) return false;
  return String(rows[0].flag_value || '').toLowerCase() === 'true';
}

function heuristicCampaignModeration(subject: string, message: string): ContentModeration {
  const text = `${subject}\n${message}`.trim();
  const lower = text.toLowerCase();
  let risk = 0;
  const reasons: string[] = [];
  const blockedPhrases = [
    'guaranteed return',
    'double your money',
    'urgent wire transfer',
    'loan approved instantly',
    'crypto giveaway',
    'click this suspicious link',
  ];
  for (const phrase of blockedPhrases) {
    if (lower.includes(phrase)) {
      risk += 35;
      reasons.push(`Suspicious phrase detected: "${phrase}"`);
    }
  }
  const links = (text.match(/https?:\/\/|www\./gi) || []).length;
  if (links > 3) {
    risk += 20;
    reasons.push('Too many links');
  }
  const uppercaseChars = (text.match(/[A-Z]/g) || []).length;
  const alphaChars = (text.match(/[A-Za-z]/g) || []).length;
  if (alphaChars > 20 && uppercaseChars / alphaChars > 0.65) {
    risk += 18;
    reasons.push('Excessive uppercase text');
  }
  if (text.length < 8) {
    risk += 25;
    reasons.push('Content too short');
  }
  const score = Math.max(0, Math.min(100, risk));
  return {
    safe: score < 60,
    risk_score: score,
    reasons: reasons.length ? reasons : ['No major risk detected'],
    suggestion: score >= 60 ? 'Use clear event details, remove risky language, and add explicit consent context.' : undefined,
    provider: 'heuristic',
  };
}

async function moderateCampaignContent(subject: string, message: string, channel: CampaignType): Promise<ContentModeration> {
  const fallback = heuristicCampaignModeration(subject, message);
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return fallback;

  try {
    const prompt = `You are a strict campaign compliance reviewer.
Return ONLY JSON with this shape:
{"safe":true,"risk_score":0,"reasons":["..."],"suggestion":"..."}

Rules:
- risk_score from 0 to 100
- safe=false if spammy/manipulative/deceptive/abusive/illegal/phishing style
- include at most 5 concise reasons
- suggestion should be short

Channel: ${channel}
Subject: ${subject || '(none)'}
Message:
${message.slice(0, 8000)}
`;
    const raw = await callGemini(prompt);
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return fallback;
    const parsed = JSON.parse(jsonMatch[0]) as {
      safe?: boolean;
      risk_score?: number;
      reasons?: string[];
      suggestion?: string;
    };
    const score = Math.max(0, Math.min(100, Number(parsed.risk_score ?? fallback.risk_score)));
    return {
      safe: typeof parsed.safe === 'boolean' ? parsed.safe : score < 60,
      risk_score: score,
      reasons: Array.isArray(parsed.reasons) && parsed.reasons.length ? parsed.reasons.slice(0, 5).map((x) => String(x)) : fallback.reasons,
      suggestion: parsed.suggestion ? String(parsed.suggestion).slice(0, 300) : fallback.suggestion,
      provider: 'gemini',
    };
  } catch {
    return fallback;
  }
}

export const parseRecipientsWithAI = async (req: AuthRequest, res: Response): Promise<void> => {
  const { raw_text } = req.body as { raw_text?: string };
  if (!raw_text || !raw_text.trim()) {
    res.status(400).json({ error: 'raw_text is required' });
    return;
  }
  try {
    if (await isCampaignServiceDisabled()) {
      res.status(503).json({ error: 'Campaign service is temporarily disabled by admin' });
      return;
    }
    let parsed: ParsedRecipient[] = [];
    const apiKey = process.env.GEMINI_API_KEY;
    if (apiKey) {
      const prompt = `Extract recipients from input. Return only JSON array of objects:
[{ "name":"", "email":"", "phone":"" }]
Rules:
- name optional
- email optional
- phone optional
- keep max 500 rows
Input:
${raw_text.slice(0, 25000)}`;
      const raw = await callGemini(prompt);
      const jsonMatch = raw.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const arr = JSON.parse(jsonMatch[0]) as InputRecipient[];
        parsed = arr.slice(0, 500).map(toScoredRecipient);
      }
    }
    if (!parsed.length) parsed = parseCsvOrTextFallback(raw_text).slice(0, 500);

    const summary = {
      total_rows: parsed.length,
      valid_rows: parsed.filter((r) => r.valid).length,
      invalid_rows: parsed.filter((r) => !r.valid).length,
      avg_score: parsed.length
        ? Math.round(parsed.reduce((a, b) => a + b.validation_score, 0) / parsed.length)
        : 0,
    };
    res.json({ recipients: parsed, summary });
  } catch (err) {
    console.error('parseRecipientsWithAI error:', err);
    res.status(500).json({ error: 'Failed to parse recipients' });
  }
};

async function getRegisteredRecipients(eventId: string, audience: string) {
  if (!rsvpColumnsCache) {
    const [cols] = await pool.query<RowDataPacket[]>(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'rsvps'`
    );
    rsvpColumnsCache = new Set(cols.map((r) => String(r.COLUMN_NAME)));
  }
  const consentExpr = rsvpColumnsCache.has('notification_consent') ? 'COALESCE(r.notification_consent, 0)' : '1';
  let q = '';
  switch (audience) {
    case 'going':
      q = `SELECT u.name, u.email, r.phone, ${consentExpr} AS consent_opted_in FROM rsvps r JOIN users u ON u.id = r.user_id WHERE r.event_id = ? AND r.status = 'going'`;
      break;
    case 'maybe':
      q = `SELECT u.name, u.email, r.phone, ${consentExpr} AS consent_opted_in FROM rsvps r JOIN users u ON u.id = r.user_id WHERE r.event_id = ? AND r.status = 'maybe'`;
      break;
    case 'waitlist':
      q = `SELECT u.name, u.email, NULL AS phone FROM waitlist w JOIN users u ON u.id = w.user_id WHERE w.event_id = ?`;
      break;
    default:
      q = `SELECT u.name, u.email, r.phone, ${consentExpr} AS consent_opted_in FROM rsvps r JOIN users u ON u.id = r.user_id WHERE r.event_id = ?`;
  }
  const [rows] = await pool.query<RowDataPacket[]>(q, [eventId]);
  return rows.map((r) => ({
    name: (r.name as string) || null,
    email: (r.email as string) || null,
    phone: (r.phone as string) || null,
    consent_opted_in: Number(r.consent_opted_in ?? 1) === 1,
    consent_source: 'event_notification_consent',
    source: 'registered' as const,
  }));
}

async function syncRegisteredRecipientsForCampaign(campaign: RowDataPacket): Promise<number> {
  const registeredRecipients = await getRegisteredRecipients(String(campaign.event_id), String(campaign.audience || 'all'));
  if (!registeredRecipients.length) return 0;

  const [existingRows] = await pool.query<RowDataPacket[]>(
    `SELECT recipient_email, recipient_phone
     FROM campaign_recipients
     WHERE campaign_id = ?`,
    [campaign.id]
  );
  const existingKeys = new Set(
    existingRows.map((r) => `${sanitizeEmail((r.recipient_email as string) || '') || ''}|${sanitizePhone((r.recipient_phone as string) || '') || ''}`)
  );

  let inserted = 0;
  for (const recipient of dedupeRecipients(registeredRecipients)) {
    const key = `${sanitizeEmail(recipient.email || undefined) || ''}|${sanitizePhone(recipient.phone || undefined) || ''}`;
    if (!key || key === '|') continue;
    if (existingKeys.has(key)) continue;
    await insertCampaignRecipient({
      campaignId: String(campaign.id),
      recipientName: recipient.name || null,
      recipientEmail: recipient.email || null,
      recipientPhone: recipient.phone || null,
      consentOptedIn: parseConsentValue(recipient.consent_opted_in),
      consentSource: recipient.consent_source || 'event_notification_consent',
      source: 'registered',
      validationScore: 100,
      validationIssuesJson: null,
    });
    existingKeys.add(key);
    inserted += 1;
  }

  if (inserted > 0) {
    await pool.query(
      `UPDATE campaigns
       SET total_recipients = (
         SELECT COUNT(*) FROM campaign_recipients WHERE campaign_id = ?
       )
       WHERE id = ?`,
      [campaign.id, campaign.id]
    );
  }
  return inserted;
}

async function createBellNotificationsForAutoReminder(campaign: RowDataPacket, event: RowDataPacket): Promise<void> {
  const note = String(campaign.compliance_notes || '');
  if (!note.startsWith('system_auto_rsvp_reminder_')) return;

  const title = String(campaign.subject || `Reminder: ${event.title || 'Event starting soon'}`);
  const message = String(campaign.message || 'Your event is starting soon. Open event details and join.');
  const payload = JSON.stringify({
    event_id: String(campaign.event_id),
    campaign_id: String(campaign.id),
    reminder_type: note,
    deep_link: `/events/${campaign.event_id}`,
  });

  await pool.query(
    `INSERT INTO notifications (id, user_id, type, title, message, data)
     SELECT UUID(), r.user_id, 'event_reminder', ?, ?, ?
     FROM rsvps r
     WHERE r.event_id = ?
       AND r.status = 'going'
       AND COALESCE(r.notification_consent, 0) = 1
       AND NOT EXISTS (
         SELECT 1
         FROM notifications n
         WHERE n.user_id = r.user_id
           AND n.type = 'event_reminder'
           AND JSON_UNQUOTE(JSON_EXTRACT(n.data, '$.campaign_id')) = ?
       )`,
    [title, message, payload, campaign.event_id, campaign.id]
  );
}

async function callGemini(prompt: string): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Gemini API key not configured');

  const res = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 1024, temperature: 0.4 },
    }),
  });

  if (!res.ok) throw new Error(`Gemini error: ${res.status}`);
  const data = await res.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
}

async function sendWhatsApp(to: string, message: string): Promise<void> {
  const waToken = process.env.WHATSAPP_TOKEN;
  const waPhoneId = process.env.WHATSAPP_PHONE_ID;
  if (!waToken || !waPhoneId) throw new Error('WhatsApp API not configured');

  const resp = await fetch(`https://graph.facebook.com/v18.0/${waPhoneId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${waToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: message },
    }),
  });
  if (!resp.ok) throw new Error('WhatsApp send failed');
}

async function sendSms(to: string, message: string): Promise<void> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;

  if (sid && token && from) {
    const auth = Buffer.from(`${sid}:${token}`).toString('base64');
    const body = new URLSearchParams({ To: `+${to}`, From: from, Body: message });
    const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });
    if (!resp.ok) throw new Error('Twilio send failed');
    return;
  }

  const smsApiUrl = process.env.SMS_API_URL;
  const smsApiKey = process.env.SMS_API_KEY;
  if (!smsApiUrl || !smsApiKey) throw new Error('SMS provider not configured');

  const resp = await fetch(smsApiUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${smsApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ to, message }),
  });
  if (!resp.ok) throw new Error('SMS send failed');
}

export const getCampaigns = async (req: AuthRequest, res: Response): Promise<void> => {
  const { event_id } = req.query as { event_id?: string };
  try {
    await ensureCampaignEnterpriseColumns();
    const where = event_id ? 'WHERE c.event_id = ? AND c.organizer_id = ?' : 'WHERE c.organizer_id = ?';
    const params = event_id ? [event_id, req.user!.id] : [req.user!.id];
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT c.*, e.title AS event_title FROM campaigns c
       JOIN events e ON e.id = c.event_id ${where}
       ORDER BY c.created_at DESC LIMIT 50`,
      params
    );
    res.json(rows);
  } catch {
    res.status(500).json({ error: 'Failed to fetch campaigns' });
  }
};

export const createCampaign = async (req: AuthRequest, res: Response): Promise<void> => {
  const {
    event_id, name, type, subject, message, audience, scheduled_at,
    recipient_source, csv_recipients, language, priority, tags, send_window_start, send_window_end, max_per_minute,
    compliance_confirmed, compliance_notes, import_consent_confirmed,
  } = req.body as {
    event_id: string;
    name: string;
    type: CampaignType;
    subject?: string;
    message: string;
    audience: string;
    scheduled_at?: string;
    recipient_source?: 'registered' | 'csv' | 'both';
    csv_recipients?: InputRecipient[];
    language?: string;
    priority?: 'low' | 'normal' | 'high';
    tags?: string;
    send_window_start?: string;
    send_window_end?: string;
    max_per_minute?: number;
    compliance_confirmed?: boolean;
    compliance_notes?: string;
    import_consent_confirmed?: boolean;
  };

  if (!event_id || !name || !message) {
    res.status(400).json({ error: 'event_id, name, and message are required' });
    return;
  }
  if (!compliance_confirmed) {
    res.status(400).json({ error: 'Consent confirmation is required before creating a campaign' });
    return;
  }

  try {
    if (await isCampaignServiceDisabled()) {
      res.status(503).json({ error: 'Campaign service is temporarily disabled by admin' });
      return;
    }
    const [[event]] = await pool.query<RowDataPacket[]>(
      'SELECT id, organizer_id FROM events WHERE id = ?', [event_id]
    );
    if (!event || event.organizer_id !== req.user!.id) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    await ensureCampaignRecipientsTable();
    await ensureCampaignEnterpriseColumns();

    const useSource = recipient_source || 'registered';
    const reg = useSource === 'registered' || useSource === 'both'
      ? await getRegisteredRecipients(event_id, audience || 'all')
      : [];

    const csvItems = (useSource === 'csv' || useSource === 'both')
      ? (csv_recipients || []).map((r) => ({
          name: r.name || null,
          email: r.email || null,
          phone: r.phone || null,
          consent_opted_in: (r.consent_opted_in === undefined || r.consent_opted_in === null || String(r.consent_opted_in).trim() === '')
            ? Boolean(import_consent_confirmed)
            : parseConsentValue(r.consent_opted_in),
          consent_source: r.consent_source || 'csv_import',
          validation_score: Number(r.validation_score ?? 100),
          validation_issues: Array.isArray(r.validation_issues) ? r.validation_issues : [],
          source: 'csv' as const,
        }))
      : [];
    if ((useSource === 'csv' || useSource === 'both') && !import_consent_confirmed) {
      res.status(400).json({ error: 'Imported contacts require consent confirmation before campaign creation' });
      return;
    }

    const importSummary = {
      total_rows: csvItems.length,
      valid_rows: csvItems.filter((r) => sanitizeEmail(r.email || undefined) || sanitizePhone(r.phone || undefined)).length,
      invalid_rows: csvItems.filter((r) => !(sanitizeEmail(r.email || undefined) || sanitizePhone(r.phone || undefined))).length,
      avg_score: csvItems.length
        ? Math.round(csvItems.reduce((a, b) => a + (Number(b.validation_score) || 0), 0) / csvItems.length)
        : 100,
    };

    const recipients = dedupeRecipients([...reg, ...csvItems]);
    if (!recipients.length) {
      res.status(400).json({ error: 'No valid recipients found' });
      return;
    }

    const id = uuidv4();
    const finalType: CampaignType = (type || 'email');
    const finalSubject = finalType === 'email'
      ? (subject?.trim() || `${name} — You're invited`)
      : null;
    const moderation = await moderateCampaignContent(finalSubject || '', message, finalType);
    if (!moderation.safe) {
      await auditCampaignAction({
        organizer_id: req.user!.id,
        action: 'campaign_blocked_ai_check',
        channel: finalType,
        severity: 'warn',
        details: { moderation, event_id },
      });
      res.status(400).json({ error: 'Campaign content blocked by AI safety review', moderation });
      return;
    }

    const label = language ? `${name} [${language}]` : name;

    await pool.query(
      `INSERT INTO campaigns (id, event_id, organizer_id, name, type, subject, message, audience, status, scheduled_at, total_recipients, priority, tags, send_window_start, send_window_end, max_per_minute, compliance_confirmed, compliance_notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        event_id,
        req.user!.id,
        label,
        finalType,
        finalSubject,
        message,
        audience || 'all',
        scheduled_at ? 'scheduled' : 'draft',
        scheduled_at || null,
        recipients.length,
        priority || 'normal',
        (tags || '').trim() || null,
        send_window_start || null,
        send_window_end || null,
        Number(max_per_minute) > 0 ? Number(max_per_minute) : 120,
        true,
        (compliance_notes || '').trim() || null,
      ]
    );

    for (const r of recipients) {
      const score = Number((r as { validation_score?: number }).validation_score ?? 100);
      const issues = (r as { validation_issues?: string[] }).validation_issues || [];
      await insertCampaignRecipient({
        campaignId: id,
        recipientName: r.name || null,
        recipientEmail: r.email || null,
        recipientPhone: r.phone || null,
        consentOptedIn: parseConsentValue((r as { consent_opted_in?: boolean }).consent_opted_in),
        consentSource: (r as { consent_source?: string | null }).consent_source || null,
        source: r.source,
        validationScore: score,
        validationIssuesJson: issues.length ? JSON.stringify(issues) : null,
      });
    }

    await auditCampaignAction({
      campaign_id: id,
      organizer_id: req.user!.id,
      action: 'campaign_created',
      channel: finalType,
      details: {
        event_id,
        recipient_count: recipients.length,
        recipient_source: useSource,
        compliance_confirmed: true,
      },
    });

    const [[campaign]] = await pool.query<RowDataPacket[]>('SELECT * FROM campaigns WHERE id = ?', [id]);
    res.status(201).json({ ...campaign, recipient_count: recipients.length, import_summary: importSummary, moderation });
  } catch (err) {
    console.error('createCampaign error:', err);
    res.status(500).json({ error: 'Failed to create campaign' });
  }
};

export const sendCampaign = async (req: AuthRequest, res: Response): Promise<void> => {
  const { id } = req.params;
  try {
    if (await isCampaignServiceDisabled()) {
      res.status(503).json({ error: 'Campaign service is temporarily disabled by admin' });
      return;
    }
    await ensureCampaignRecipientsTable();
    await ensureCampaignEnterpriseColumns();
    await ensureCampaignAuditTable();
    await ensureEmailUnsubscribesTable();

    const [[campaign]] = await pool.query<RowDataPacket[]>(
      'SELECT * FROM campaigns WHERE id = ? AND organizer_id = ?', [id, req.user!.id]
    );
    if (!campaign) { res.status(404).json({ error: 'Campaign not found' }); return; }
    if (campaign.status === 'sending') {
      res.status(400).json({ error: 'Campaign already sending' });
      return;
    }
    if (!inSendWindow(campaign.send_window_start as string | null, campaign.send_window_end as string | null)) {
      res.status(400).json({ error: 'Outside configured send window' });
      return;
    }
    const moderation = await moderateCampaignContent(String(campaign.subject || ''), String(campaign.message || ''), campaign.type as CampaignType);
    if (!moderation.safe) {
      await auditCampaignAction({
        campaign_id: id,
        organizer_id: req.user!.id,
        action: 'campaign_send_blocked_ai_check',
        channel: campaign.type as string,
        severity: 'warn',
        details: { moderation },
      });
      res.status(400).json({ error: 'Campaign blocked by AI safety check. Update content and retry.', moderation });
      return;
    }

    const [allRecipients] = await pool.query<RecipientRow[]>(
      `SELECT * FROM campaign_recipients
       WHERE campaign_id = ? AND status IN ('pending', 'failed')
       ORDER BY validation_score DESC, id ASC`,
      [id]
    );
    if (!allRecipients.length) {
      res.status(400).json({ error: 'No recipients pending for this campaign' });
      return;
    }
    const recipients = allRecipients.filter((r) => Number(r.consent_opted_in || 0) === 1);
    if (!recipients.length) {
      await auditCampaignAction({
        campaign_id: id,
        organizer_id: req.user!.id,
        action: 'campaign_send_blocked_no_consent',
        channel: campaign.type as string,
        severity: 'warn',
        details: { pending: allRecipients.length },
      });
      res.status(400).json({ error: 'No compliant recipients: consent is required before sending campaigns' });
      return;
    }

    await pool.query('UPDATE campaigns SET status = ? WHERE id = ?', ['sending', id]);
    await auditCampaignAction({
      campaign_id: id,
      organizer_id: req.user!.id,
      action: 'campaign_send_started',
      channel: campaign.type as string,
      details: { total_pending: allRecipients.length, compliant_recipients: recipients.length },
    });
    res.json({
      message: 'Campaign queued for async delivery',
      queued_recipients: recipients.length,
      type: campaign.type,
      status: 'queued',
    });
  } catch (err) {
    console.error('sendCampaign error:', err);
    await pool.query('UPDATE campaigns SET status = ? WHERE id = ?', ['failed', id]);
    await auditCampaignAction({
      campaign_id: id,
      organizer_id: req.user!.id,
      action: 'campaign_send_failed',
      severity: 'error',
      details: { error: (err as Error).message },
    });
    res.status(500).json({ error: 'Failed to queue campaign send' });
  }
};

async function processSingleQueuedCampaign(campaign: RowDataPacket): Promise<void> {
  const campaignId = String(campaign.id);
  const lockName = `campaign_send_${campaignId}`;
  const [[lockRow]] = await pool.query<RowDataPacket[]>(
    'SELECT GET_LOCK(?, 0) AS got_lock',
    [lockName]
  );
  if (Number(lockRow?.got_lock || 0) !== 1) return;

  try {
    if (!inSendWindow(campaign.send_window_start as string | null, campaign.send_window_end as string | null)) {
      return;
    }
    await syncRegisteredRecipientsForCampaign(campaign);
    const [allRecipients] = await pool.query<RecipientRow[]>(
      `SELECT * FROM campaign_recipients
       WHERE campaign_id = ? AND status IN ('pending', 'failed')
       ORDER BY validation_score DESC, id ASC`,
      [campaignId]
    );
    if (!allRecipients.length) {
      await pool.query(
        'UPDATE campaigns SET status = CASE WHEN sent_count > 0 THEN ? ELSE ? END WHERE id = ?',
        ['sent', 'failed', campaignId]
      );
      return;
    }

    const recipients = allRecipients.filter((r) => Number(r.consent_opted_in || 0) === 1);
    if (!recipients.length) {
      await pool.query('UPDATE campaigns SET status = ? WHERE id = ?', ['failed', campaignId]);
      await auditCampaignAction({
        campaign_id: campaignId,
        organizer_id: String(campaign.organizer_id),
        action: 'campaign_send_blocked_no_consent',
        channel: String(campaign.type || ''),
        severity: 'warn',
        details: { pending: allRecipients.length },
      });
      return;
    }

    const [[event]] = await pool.query<RowDataPacket[]>(
      `SELECT e.*, u.name AS organizer_name
       FROM events e JOIN users u ON u.id = e.organizer_id WHERE e.id = ?`,
      [campaign.event_id]
    );
    if (!event) {
      await pool.query('UPDATE campaigns SET status = ? WHERE id = ?', ['failed', campaignId]);
      await auditCampaignAction({
        campaign_id: campaignId,
        organizer_id: String(campaign.organizer_id),
        action: 'campaign_send_failed',
        severity: 'error',
        details: { error: 'Event not found for campaign' },
      });
      return;
    }

    let sent = 0;
    let failed = 0;
    await createBellNotificationsForAutoReminder(campaign, event);
    const appUrl = process.env.FRONTEND_URL || 'https://host-events.appsmagic.in';
    const eventUrl = `${appUrl}/events/${campaign.event_id}`;
    const perMinute = Math.max(10, Number(campaign.max_per_minute || 120));
    const delayMs = Math.max(50, Math.floor(60000 / perMinute));

    for (const r of recipients) {
      try {
        if (String(campaign.type) === 'email') {
          if (!r.recipient_email) throw new Error('Missing email');
          if (await isEmailUnsubscribed(r.recipient_email)) {
            await pool.query(
              'UPDATE campaign_recipients SET status = ?, error_message = ? WHERE id = ?',
              ['failed', 'unsubscribed', r.id]
            );
            failed += 1;
            continue;
          }
          const subject = String(campaign.subject || campaign.name || '');
          const message = String(campaign.message || '');
          const isInviteStyle = subject.toLowerCase().includes('invite') || message.toLowerCase().includes('invite');
          const unsubscribeUrl = buildUnsubscribeUrl(r.recipient_email, campaignId);
          const html = isInviteStyle
            ? eventInviteTemplate(event as any, eventUrl, message, unsubscribeUrl)
            : buildCustomEmailHtml(message, event as any, r.recipient_name || 'there', eventUrl, unsubscribeUrl);
          await sendEmail(r.recipient_email, subject || String(campaign.name || 'Campaign'), html, {
            'List-Unsubscribe': `<${unsubscribeUrl}>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          });
        } else if (String(campaign.type) === 'sms') {
          if (!r.recipient_phone) throw new Error('Missing phone');
          await sendSms(r.recipient_phone, String(campaign.message || ''));
        } else {
          if (!r.recipient_phone) throw new Error('Missing phone');
          await sendWhatsApp(r.recipient_phone, String(campaign.message || ''));
        }

        await pool.query(
          'UPDATE campaign_recipients SET status = ?, sent_at = NOW(), error_message = NULL WHERE id = ?',
          ['sent', r.id]
        );
        sent += 1;
      } catch (e) {
        const errMsg = String((e as Error).message || 'delivery_failed').slice(0, 500);
        await pool.query(
          'UPDATE campaign_recipients SET status = ?, error_message = ? WHERE id = ?',
          ['failed', errMsg, r.id]
        );
        failed += 1;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    const finalStatus = sent > 0 ? 'sent' : 'failed';
    await pool.query(
      'UPDATE campaigns SET status = ?, sent_count = sent_count + ?, failed_count = failed_count + ? WHERE id = ?',
      [finalStatus, sent, failed, campaignId]
    );
    await auditCampaignAction({
      campaign_id: campaignId,
      organizer_id: String(campaign.organizer_id),
      action: 'campaign_send_finished',
      channel: String(campaign.type || ''),
      details: { sent, failed, attempted: recipients.length },
    });
  } finally {
    await pool.query('DO RELEASE_LOCK(?)', [lockName]);
  }
}

export async function processQueuedCampaignSends(): Promise<void> {
  if (campaignSendWorkerActive) return;
  campaignSendWorkerActive = true;
  try {
    if (await isCampaignServiceDisabled()) return;
    await ensureCampaignRecipientsTable();
    await ensureCampaignEnterpriseColumns();
    await ensureCampaignAuditTable();
    await ensureEmailUnsubscribesTable();

    await pool.query(
      `UPDATE campaigns
       SET status = 'sending'
       WHERE status = 'scheduled'
         AND scheduled_at IS NOT NULL
         AND scheduled_at <= NOW()`
    );

    const [campaigns] = await pool.query<RowDataPacket[]>(
      `SELECT *
       FROM campaigns
       WHERE status = 'sending'
       ORDER BY updated_at ASC
       LIMIT 3`
    );

    for (const campaign of campaigns) {
      await processSingleQueuedCampaign(campaign);
    }
  } catch (err) {
    console.error('processQueuedCampaignSends error:', err);
  } finally {
    campaignSendWorkerActive = false;
  }
}

export const sendCampaignTest = async (req: AuthRequest, res: Response): Promise<void> => {
  const { id } = req.params;
  const { email, phone, message } = req.body as { email?: string; phone?: string; message?: string };
  try {
    if (await isCampaignServiceDisabled()) {
      res.status(503).json({ error: 'Campaign service is temporarily disabled by admin' });
      return;
    }
    await ensureCampaignEnterpriseColumns();
    await ensureCampaignRecipientsTable();
    const [[campaign]] = await pool.query<RowDataPacket[]>(
      'SELECT * FROM campaigns WHERE id = ? AND organizer_id = ?', [id, req.user!.id]
    );
    if (!campaign) { res.status(404).json({ error: 'Campaign not found' }); return; }
    const text = (message || campaign.message || '').trim();
    if (!text) { res.status(400).json({ error: 'Message required' }); return; }
    const moderation = await moderateCampaignContent(String(campaign.subject || ''), text, campaign.type as CampaignType);
    if (!moderation.safe) {
      res.status(400).json({ error: 'Test send blocked by AI safety check', moderation });
      return;
    }

    if (campaign.type === 'email') {
      const to = sanitizeEmail(email);
      if (!to) { res.status(400).json({ error: 'Valid email required for test send' }); return; }
      const [matched] = await pool.query<RowDataPacket[]>(
        `SELECT id FROM campaign_recipients
         WHERE campaign_id = ? AND recipient_email = ? AND consent_opted_in = 1
         LIMIT 1`,
        [id, to]
      );
      if (!matched.length) {
        res.status(400).json({ error: 'Test email must be from campaign recipients with consent' });
        return;
      }
      await sendEmail(to, campaign.subject || `${campaign.name} test`, `<p>${text.replace(/\n/g, '<br/>')}</p>`);
    } else if (campaign.type === 'sms') {
      const to = sanitizePhone(phone);
      if (!to) { res.status(400).json({ error: 'Valid phone required for test send' }); return; }
      const [matched] = await pool.query<RowDataPacket[]>(
        `SELECT id FROM campaign_recipients
         WHERE campaign_id = ? AND recipient_phone = ? AND consent_opted_in = 1
         LIMIT 1`,
        [id, to]
      );
      if (!matched.length) {
        res.status(400).json({ error: 'Test phone must be from campaign recipients with consent' });
        return;
      }
      await sendSms(to, text);
    } else {
      const to = sanitizePhone(phone);
      if (!to) { res.status(400).json({ error: 'Valid phone required for test send' }); return; }
      const [matched] = await pool.query<RowDataPacket[]>(
        `SELECT id FROM campaign_recipients
         WHERE campaign_id = ? AND recipient_phone = ? AND consent_opted_in = 1
         LIMIT 1`,
        [id, to]
      );
      if (!matched.length) {
        res.status(400).json({ error: 'Test phone must be from campaign recipients with consent' });
        return;
      }
      await sendWhatsApp(to, text);
    }
    await auditCampaignAction({
      campaign_id: id,
      organizer_id: req.user!.id,
      action: 'campaign_test_send',
      channel: campaign.type as string,
      details: { target: campaign.type === 'email' ? sanitizeEmail(email) : sanitizePhone(phone) },
    });
    res.json({ message: 'Test message sent successfully' });
  } catch (err) {
    console.error('sendCampaignTest error:', err);
    res.status(500).json({ error: 'Failed to send test message' });
  }
};

function buildCustomEmailHtml(
  message: string,
  event: Record<string, unknown>,
  recipientName: string,
  eventUrl: string,
  unsubscribeUrl: string
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
        <tr><td style="background:linear-gradient(135deg,#7c3aed,#4f46e5);padding:28px 40px;">
          <h2 style="margin:0;color:#fff;font-size:20px;">${String(event.title)}</h2>
        </td></tr>
        <tr><td style="padding:32px 40px;">
          <p style="margin:0 0 8px;color:#64748b;font-size:13px;">Hi ${recipientName},</p>
          <div style="font-size:14px;color:#1e293b;line-height:1.7;white-space:pre-wrap;">${message}</div>
          <div style="margin-top:28px;text-align:center;">
            <a href="${eventUrl}" style="display:inline-block;background:linear-gradient(135deg,#7c3aed,#4f46e5);color:#fff;font-size:14px;font-weight:700;text-decoration:none;padding:12px 32px;border-radius:12px;">
              View Event →
            </a>
          </div>
        </td></tr>
        <tr><td style="background:#f8fafc;padding:20px 40px;text-align:center;">
          <p style="margin:0;font-size:12px;color:#94a3b8;">Sent via <a href="https://events.appsmagic.in" style="color:#7c3aed;">AppsMagic Events</a></p>
          <p style="margin:8px 0 0;font-size:11px;color:#94a3b8;">
            <a href="${unsubscribeUrl}" style="color:#64748b;">Unsubscribe from campaign emails</a>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

export const campaignEmailUnsubscribe = async (req: Request, res: Response): Promise<void> => {
  try {
    await ensureEmailUnsubscribesTable();
    const token = String(req.query.token || '');
    if (!token) {
      res.status(400).send('Missing unsubscribe token');
      return;
    }
    const payload = jwt.verify(token, process.env.JWT_SECRET!) as { email?: string; campaign_id?: string; type?: string };
    if (payload.type !== 'campaign_unsub' || !payload.email) {
      res.status(400).send('Invalid unsubscribe token');
      return;
    }
    const email = payload.email.trim().toLowerCase();
    await pool.query(
      `INSERT INTO email_unsubscribes (email, source)
       VALUES (?, 'campaign_unsubscribe')
       ON DUPLICATE KEY UPDATE source = 'campaign_unsubscribe'`,
      [email]
    );
    await pool.query(
      `UPDATE campaign_recipients
       SET consent_opted_in = 0
       WHERE recipient_email = ?`,
      [email]
    );
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(`<!doctype html><html><body style="font-family:Arial,sans-serif;padding:32px"><h2>Unsubscribed</h2><p>${email} has been unsubscribed from campaign emails.</p><p><a href="https://events.appsmagic.in">Back to Events</a></p></body></html>`);
  } catch {
    res.status(400).send('Unsubscribe link is invalid or expired');
  }
};

export const generateCampaignTemplate = async (req: AuthRequest, res: Response): Promise<void> => {
  const { event_id, channel, language, prompt, tone } = req.body as {
    event_id: string;
    channel: CampaignType;
    language?: string;
    prompt?: string;
    tone?: string;
  };

  if (!event_id || !channel) {
    res.status(400).json({ error: 'event_id and channel are required' });
    return;
  }

  try {
    if (await isCampaignServiceDisabled()) {
      res.status(503).json({ error: 'Campaign service is temporarily disabled by admin' });
      return;
    }
    const [[event]] = await pool.query<RowDataPacket[]>(
      `SELECT id, title, short_description, city, venue_name, start_date, is_online
       FROM events WHERE id = ?`,
      [event_id]
    );
    if (!event) {
      res.status(404).json({ error: 'Event not found' });
      return;
    }

    const outLang = language && language.trim() ? language.trim() : 'English';
    const style = tone?.trim() || 'friendly';
    const userPrompt = prompt?.trim() || 'Invite users to register and join the event.';

    const aiPrompt = `Generate campaign copy for an event.
Return ONLY JSON:
{"subject":"string","message":"string"}

Rules:
- Language: ${outLang}
- Channel: ${channel}
- Tone: ${style}
- Keep concise and conversion-focused.
- Include a clear CTA to join/register.
- Do not invent facts.
- For sms/whatsapp keep under 500 chars.

Event:
- title: ${event.title}
- short_description: ${event.short_description || ''}
- city: ${event.city || ''}
- venue: ${event.venue_name || ''}
- start_date: ${event.start_date}
- is_online: ${event.is_online ? 'yes' : 'no'}

User intent: ${userPrompt}`;

    const raw = await callGemini(aiPrompt);
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      res.status(422).json({ error: 'Could not parse AI template' });
      return;
    }

    const parsed = JSON.parse(jsonMatch[0]) as { subject?: string; message?: string };
    res.json({
      subject: channel === 'email' ? (parsed.subject || `You're invited: ${event.title}`) : null,
      message: parsed.message || `Join us for ${event.title}.`,
      language: outLang,
    });
  } catch (err) {
    console.error('generateCampaignTemplate error:', err);
    res.status(500).json({ error: 'Failed to generate template' });
  }
};

export const getCampaignStats = async (req: AuthRequest, res: Response): Promise<void> => {
  const { id } = req.params;
  try {
    const [[campaign]] = await pool.query<RowDataPacket[]>(
      'SELECT * FROM campaigns WHERE id = ? AND organizer_id = ?', [id, req.user!.id]
    );
    if (!campaign) { res.status(404).json({ error: 'Not found' }); return; }
    res.json({
      ...campaign,
      delivery_rate: campaign.total_recipients
        ? Math.round((campaign.sent_count / campaign.total_recipients) * 100)
        : 0,
    });
  } catch {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
};

export const getCampaignComplianceCheck = async (req: AuthRequest, res: Response): Promise<void> => {
  const { id } = req.params;
  try {
    await ensureCampaignRecipientsTable();
    const [[campaign]] = await pool.query<RowDataPacket[]>(
      'SELECT id, organizer_id, type, status FROM campaigns WHERE id = ?',
      [id]
    );
    if (!campaign) { res.status(404).json({ error: 'Campaign not found' }); return; }
    if (campaign.organizer_id !== req.user!.id && req.user!.role !== 'admin') {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    const [[agg]] = await pool.query<RowDataPacket[]>(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN consent_opted_in = 1 THEN 1 ELSE 0 END) AS consented,
         SUM(CASE WHEN consent_opted_in = 0 OR consent_opted_in IS NULL THEN 1 ELSE 0 END) AS missing_consent,
         SUM(CASE WHEN (recipient_email IS NULL OR recipient_email = '') AND (recipient_phone IS NULL OR recipient_phone = '') THEN 1 ELSE 0 END) AS invalid_contact
       FROM campaign_recipients
       WHERE campaign_id = ?`,
      [id]
    );

    const total = Number(agg.total || 0);
    const consented = Number(agg.consented || 0);
    const missingConsent = Number(agg.missing_consent || 0);
    const invalidContact = Number(agg.invalid_contact || 0);
    res.json({
      campaign_id: id,
      status: campaign.status,
      channel: campaign.type,
      total_recipients: total,
      consented_recipients: consented,
      missing_consent_recipients: missingConsent,
      invalid_contact_recipients: invalidContact,
      can_send: consented > 0,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to compute compliance check' });
  }
};

export const getCampaignAuditLogs = async (req: AuthRequest, res: Response): Promise<void> => {
  const { campaign_id, event_id, limit } = req.query as { campaign_id?: string; event_id?: string; limit?: string };
  try {
    await ensureCampaignAuditTable();
    const parsedLimit = Number(limit);
    const max = Number.isFinite(parsedLimit)
      ? Math.min(500, Math.max(1, Math.trunc(parsedLimit)))
      : 100;
    let sql = `
      SELECT l.id, l.campaign_id, l.organizer_id, u.name AS organizer_name, l.action, l.channel, l.severity, l.details_json, l.created_at
      FROM campaign_audit_logs l
      LEFT JOIN users u ON u.id = l.organizer_id
      WHERE 1=1
    `;
    const params: unknown[] = [];
    if (campaign_id) {
      sql += ' AND l.campaign_id = ?';
      params.push(campaign_id);
    }
    if (event_id) {
      sql += ' AND l.campaign_id IN (SELECT id FROM campaigns WHERE event_id = ?)';
      params.push(event_id);
    }
    if (req.user!.role !== 'admin') {
      sql += ' AND l.organizer_id = ?';
      params.push(req.user!.id);
    }
    sql += ' ORDER BY l.id DESC LIMIT ?';
    params.push(max);
    const [rows] = await pool.query<RowDataPacket[]>(sql, params);
    res.json(rows);
  } catch (err) {
    console.error('getCampaignAuditLogs failed:', err);
    res.status(500).json({ error: 'Failed to fetch campaign audit logs' });
  }
};

export const getCampaignServiceState = async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const disabled = await isCampaignServiceDisabled();
    res.json({ disabled });
  } catch {
    res.status(500).json({ error: 'Failed to fetch campaign service state' });
  }
};

export const setCampaignServiceState = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (req.user?.role !== 'admin') {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    const disabled = Boolean(req.body?.disabled);
    await ensureRuntimeFlagsTable();
    await pool.query(
      `INSERT INTO app_runtime_flags (flag_key, flag_value, updated_by)
       VALUES ('campaign_service_disabled', ?, ?)
       ON DUPLICATE KEY UPDATE flag_value = VALUES(flag_value), updated_by = VALUES(updated_by), updated_at = CURRENT_TIMESTAMP`,
      [disabled ? 'true' : 'false', req.user.id]
    );
    await auditCampaignAction({
      organizer_id: req.user.id,
      action: 'campaign_service_state_changed',
      severity: 'warn',
      details: { disabled },
    });
    res.json({ disabled });
  } catch {
    res.status(500).json({ error: 'Failed to update campaign service state' });
  }
};

export const deleteCampaign = async (req: AuthRequest, res: Response): Promise<void> => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM campaigns WHERE id = ? AND organizer_id = ?', [id, req.user!.id]);
    res.json({ message: 'Campaign deleted' });
  } catch {
    res.status(500).json({ error: 'Failed to delete campaign' });
  }
};
