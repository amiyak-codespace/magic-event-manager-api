import pool from './db';

const schema = `
CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(36) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password VARCHAR(255) NOT NULL,
  avatar VARCHAR(500),
  role ENUM('user', 'organizer', 'admin') DEFAULT 'user',
  status ENUM('active', 'blocked') DEFAULT 'active',
  last_login_at DATETIME NULL,
  last_login_ip VARCHAR(100),
  terms_accepted BOOLEAN DEFAULT FALSE,
  privacy_accepted BOOLEAN DEFAULT FALSE,
  consented_at DATETIME NULL,
  consent_version VARCHAR(20) DEFAULT '2026-03',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS consent_events (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  consent_type ENUM('terms','privacy') NOT NULL,
  policy_version VARCHAR(20) NOT NULL,
  accepted BOOLEAN NOT NULL DEFAULT TRUE,
  accepted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  source VARCHAR(100) DEFAULT 'register',
  ip_address VARCHAR(100),
  user_agent VARCHAR(500),
  INDEX idx_user (user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS categories (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  slug VARCHAR(100) UNIQUE NOT NULL,
  icon VARCHAR(50),
  color VARCHAR(20)
);

INSERT IGNORE INTO categories (name, slug, icon, color) VALUES
  ('Music', 'music', '🎵', '#8B5CF6'),
  ('Sports', 'sports', '🏅', '#10B981'),
  ('Tech', 'tech', '💻', '#3B82F6'),
  ('Food & Drink', 'food-drink', '🍕', '#F59E0B'),
  ('Arts', 'arts', '🎨', '#EC4899'),
  ('Business', 'business', '💼', '#6366F1'),
  ('Fitness', 'fitness', '💪', '#14B8A6'),
  ('Networking', 'networking', '🤝', '#F97316');

CREATE TABLE IF NOT EXISTS events (
  id VARCHAR(36) PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  short_description VARCHAR(500),
  category_id INT,
  organizer_id VARCHAR(36) NOT NULL,
  banner_url VARCHAR(500),
  venue_name VARCHAR(255),
  venue_address TEXT,
  city VARCHAR(100),
  state VARCHAR(100),
  country VARCHAR(100) DEFAULT 'India',
  latitude DECIMAL(10, 8),
  longitude DECIMAL(11, 8),
  start_date DATETIME NOT NULL,
  end_date DATETIME NOT NULL,
  registration_deadline DATETIME,
  max_attendees INT,
  current_attendees INT DEFAULT 0,
  is_free BOOLEAN DEFAULT TRUE,
  price DECIMAL(10, 2) DEFAULT 0.00,
  currency VARCHAR(10) DEFAULT 'INR',
  status ENUM('draft', 'published', 'cancelled', 'completed') DEFAULT 'draft',
  event_started BOOLEAN DEFAULT FALSE,
  event_started_at DATETIME NULL,
  is_recurring BOOLEAN DEFAULT FALSE,
  recurrence_frequency ENUM('daily', 'weekly', 'monthly') NULL,
  recurrence_interval INT DEFAULT 1,
  recurrence_end_type ENUM('never', 'on_date', 'after_count') DEFAULT 'never',
  recurrence_end_date DATETIME NULL,
  recurrence_count_limit INT NULL,
  recurrence_generated_count INT DEFAULT 0,
  recurrence_parent_id VARCHAR(36) NULL,
  last_recurrence_generated_at DATETIME NULL,
  is_private BOOLEAN DEFAULT FALSE,
  is_online BOOLEAN DEFAULT FALSE,
  online_link VARCHAR(500),
  tags TEXT,
  invite_template ENUM('birthday','wedding','corporate','custom') DEFAULT 'custom',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (category_id) REFERENCES categories(id),
  FOREIGN KEY (organizer_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS rsvps (
  id VARCHAR(36) PRIMARY KEY,
  event_id VARCHAR(36) NOT NULL,
  user_id VARCHAR(36) NOT NULL,
  status ENUM('going', 'maybe', 'not_going') DEFAULT 'going',
  ticket_code VARCHAR(50) UNIQUE,
  checked_in BOOLEAN DEFAULT FALSE,
  checked_in_at TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_event_user (event_id, user_id),
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS event_likes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  event_id VARCHAR(36) NOT NULL,
  user_id VARCHAR(36) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_event_user_like (event_id, user_id),
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS digital_invitations (
  id VARCHAR(36) PRIMARY KEY,
  event_id VARCHAR(36) NOT NULL,
  template VARCHAR(50) DEFAULT 'default',
  custom_message TEXT,
  share_token VARCHAR(100) UNIQUE NOT NULL,
  view_count INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS notifications (
  id VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  type VARCHAR(50) NOT NULL,
  title VARCHAR(255) NOT NULL,
  message TEXT,
  data JSON,
  is_read BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS campaigns (
  id VARCHAR(36) PRIMARY KEY,
  event_id VARCHAR(36) NOT NULL,
  organizer_id VARCHAR(36) NOT NULL,
  name VARCHAR(255) NOT NULL,
  type ENUM('email','whatsapp','sms') DEFAULT 'email',
  subject VARCHAR(255),
  message TEXT NOT NULL,
  audience VARCHAR(50) DEFAULT 'all',
  status ENUM('draft','sending','sent','failed','scheduled') DEFAULT 'draft',
  scheduled_at DATETIME NULL,
  sent_count INT DEFAULT 0,
  failed_count INT DEFAULT 0,
  total_recipients INT DEFAULT 0,
  compliance_confirmed BOOLEAN DEFAULT FALSE,
  compliance_notes TEXT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  FOREIGN KEY (organizer_id) REFERENCES users(id) ON DELETE CASCADE
);

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
);

CREATE TABLE IF NOT EXISTS campaign_audit_logs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  campaign_id VARCHAR(36) NULL,
  organizer_id VARCHAR(36) NOT NULL,
  action VARCHAR(64) NOT NULL,
  channel VARCHAR(20) NULL,
  severity ENUM('info','warn','error') DEFAULT 'info',
  details_json JSON NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_campaign (campaign_id),
  INDEX idx_organizer (organizer_id)
);

CREATE TABLE IF NOT EXISTS subscription_plans (
  id VARCHAR(36) PRIMARY KEY,
  code VARCHAR(50) UNIQUE NOT NULL,
  name VARCHAR(120) NOT NULL,
  description TEXT,
  price_inr INT NOT NULL DEFAULT 0,
  interval_months INT NOT NULL DEFAULT 1,
  features_json JSON NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_subscriptions (
  id VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  plan_id VARCHAR(36) NOT NULL,
  status ENUM('active','cancelled','expired') DEFAULT 'active',
  started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_user_subscriptions_user (user_id),
  INDEX idx_user_subscriptions_plan (plan_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (plan_id) REFERENCES subscription_plans(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS subscription_payments (
  id VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  plan_id VARCHAR(36) NOT NULL,
  provider VARCHAR(20) NOT NULL DEFAULT 'razorpay',
  provider_order_id VARCHAR(120),
  provider_payment_id VARCHAR(120),
  amount_inr INT NOT NULL,
  currency VARCHAR(10) NOT NULL DEFAULT 'INR',
  status ENUM('created','paid','failed') DEFAULT 'created',
  signature_verified BOOLEAN DEFAULT FALSE,
  payload_json JSON NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_subscription_payments_user (user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (plan_id) REFERENCES subscription_plans(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS security_activity_logs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id VARCHAR(36) NULL,
  email VARCHAR(255) NULL,
  action VARCHAR(80) NOT NULL,
  endpoint VARCHAR(255) NULL,
  method VARCHAR(10) NULL,
  success BOOLEAN NOT NULL DEFAULT TRUE,
  ip_address VARCHAR(100) NULL,
  user_agent VARCHAR(500) NULL,
  metadata_json JSON NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_security_created_at (created_at),
  INDEX idx_security_action (action),
  INDEX idx_security_user (user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

INSERT IGNORE INTO subscription_plans (id, code, name, description, price_inr, interval_months, features_json, is_active) VALUES
  ('20000000-0000-0000-0000-000000000001', 'free', 'Free', 'Perfect for trying EventMagic', 0, 1, JSON_ARRAY('Up to 3 events', '50 attendees per event', 'Basic RSVP'), TRUE),
  ('20000000-0000-0000-0000-000000000002', 'pro', 'Pro', 'For active organizers', 499, 1, JSON_ARRAY('Unlimited events', '500 attendees per event', 'Analytics'), TRUE),
  ('20000000-0000-0000-0000-000000000003', 'business', 'Business', 'For large scale events', 1999, 1, JSON_ARRAY('Unlimited attendees', 'Paid ticketing', 'White-label pages'), TRUE);
`;

async function migrate() {
  const connection = await pool.getConnection();
  try {
    console.log('Running EventMagic database migrations...');
    const statements = schema
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    for (const statement of statements) {
      await connection.query(statement);
    }

    // Backfill for older databases where events table exists without is_private.
    const [columns] = await connection.query<any[]>(
      `SELECT 1
       FROM information_schema.columns
       WHERE table_schema = DATABASE()
         AND table_name = 'events'
         AND column_name = 'is_private'
       LIMIT 1`
    );
    if (!columns.length) {
      await connection.query('ALTER TABLE events ADD COLUMN is_private BOOLEAN DEFAULT FALSE');
    }
    const eventColsToEnsure = [
      { name: 'event_started', ddl: 'ALTER TABLE events ADD COLUMN event_started BOOLEAN DEFAULT FALSE' },
      { name: 'event_started_at', ddl: 'ALTER TABLE events ADD COLUMN event_started_at DATETIME NULL' },
      { name: 'is_recurring', ddl: 'ALTER TABLE events ADD COLUMN is_recurring BOOLEAN DEFAULT FALSE' },
      { name: 'recurrence_frequency', ddl: "ALTER TABLE events ADD COLUMN recurrence_frequency ENUM('daily','weekly','monthly') NULL" },
      { name: 'recurrence_interval', ddl: 'ALTER TABLE events ADD COLUMN recurrence_interval INT DEFAULT 1' },
      { name: 'recurrence_end_type', ddl: "ALTER TABLE events ADD COLUMN recurrence_end_type ENUM('never','on_date','after_count') DEFAULT 'never'" },
      { name: 'recurrence_end_date', ddl: 'ALTER TABLE events ADD COLUMN recurrence_end_date DATETIME NULL' },
      { name: 'recurrence_count_limit', ddl: 'ALTER TABLE events ADD COLUMN recurrence_count_limit INT NULL' },
      { name: 'recurrence_generated_count', ddl: 'ALTER TABLE events ADD COLUMN recurrence_generated_count INT DEFAULT 0' },
      { name: 'recurrence_parent_id', ddl: 'ALTER TABLE events ADD COLUMN recurrence_parent_id VARCHAR(36) NULL' },
      { name: 'last_recurrence_generated_at', ddl: 'ALTER TABLE events ADD COLUMN last_recurrence_generated_at DATETIME NULL' },
      { name: 'invite_template', ddl: "ALTER TABLE events ADD COLUMN invite_template ENUM('birthday','wedding','corporate','custom') DEFAULT 'custom'" },
    ];
    for (const c of eventColsToEnsure) {
      const [existing] = await connection.query<any[]>(
        `SELECT 1 FROM information_schema.columns
         WHERE table_schema = DATABASE()
           AND table_name = 'events'
           AND column_name = ?
         LIMIT 1`,
        [c.name]
      );
      if (!existing.length) await connection.query(c.ddl);
    }
    const colsToEnsure = [
      { name: 'terms_accepted', ddl: 'ALTER TABLE users ADD COLUMN terms_accepted BOOLEAN DEFAULT FALSE' },
      { name: 'privacy_accepted', ddl: 'ALTER TABLE users ADD COLUMN privacy_accepted BOOLEAN DEFAULT FALSE' },
      { name: 'consented_at', ddl: 'ALTER TABLE users ADD COLUMN consented_at DATETIME NULL' },
      { name: 'consent_version', ddl: "ALTER TABLE users ADD COLUMN consent_version VARCHAR(20) DEFAULT '2026-03'" },
      { name: 'status', ddl: "ALTER TABLE users ADD COLUMN status ENUM('active','blocked') DEFAULT 'active'" },
      { name: 'last_login_at', ddl: 'ALTER TABLE users ADD COLUMN last_login_at DATETIME NULL' },
      { name: 'last_login_ip', ddl: 'ALTER TABLE users ADD COLUMN last_login_ip VARCHAR(100)' },
    ];
    for (const c of colsToEnsure) {
      const [existing] = await connection.query<any[]>(
        `SELECT 1 FROM information_schema.columns
         WHERE table_schema = DATABASE()
           AND table_name = 'users'
           AND column_name = ?
         LIMIT 1`,
        [c.name]
      );
      if (!existing.length) await connection.query(c.ddl);
    }

    const campaignRecipientCols = [
      { name: 'validation_score', ddl: 'ALTER TABLE campaign_recipients ADD COLUMN validation_score INT DEFAULT 100' },
      { name: 'validation_issues', ddl: 'ALTER TABLE campaign_recipients ADD COLUMN validation_issues TEXT' },
      { name: 'consent_opted_in', ddl: 'ALTER TABLE campaign_recipients ADD COLUMN consent_opted_in BOOLEAN DEFAULT FALSE' },
      { name: 'consent_source', ddl: 'ALTER TABLE campaign_recipients ADD COLUMN consent_source VARCHAR(80) NULL' },
      { name: 'consent_captured_at', ddl: 'ALTER TABLE campaign_recipients ADD COLUMN consent_captured_at DATETIME NULL' },
    ];
    for (const c of campaignRecipientCols) {
      const [existing] = await connection.query<any[]>(
        `SELECT 1 FROM information_schema.columns
         WHERE table_schema = DATABASE()
           AND table_name = 'campaign_recipients'
           AND column_name = ?
         LIMIT 1`,
        [c.name]
      );
      if (!existing.length) await connection.query(c.ddl);
    }
    const campaignCols = [
      { name: 'compliance_confirmed', ddl: 'ALTER TABLE campaigns ADD COLUMN compliance_confirmed BOOLEAN DEFAULT FALSE' },
      { name: 'compliance_notes', ddl: 'ALTER TABLE campaigns ADD COLUMN compliance_notes TEXT NULL' },
    ];
    for (const c of campaignCols) {
      const [existing] = await connection.query<any[]>(
        `SELECT 1 FROM information_schema.columns
         WHERE table_schema = DATABASE()
           AND table_name = 'campaigns'
           AND column_name = ?
         LIMIT 1`,
        [c.name]
      );
      if (!existing.length) await connection.query(c.ddl);
    }
    console.log('✅ Migrations complete');
  } catch (err) {
    console.error('Migration error:', err);
    throw err;
  } finally {
    connection.release();
    await pool.end();
  }
}

migrate();
