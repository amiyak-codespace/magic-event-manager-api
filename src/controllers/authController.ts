import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import pool from '../utils/db';
import { RowDataPacket } from 'mysql2';
import { logSecurityActivity, requestIp } from '../utils/security';
import { logger } from '../observability/logger';

interface User extends RowDataPacket {
  id: string;
  name: string;
  email: string;
  password: string;
  avatar: string | null;
  role: string;
  status?: string;
  terms_accepted?: number | boolean;
  privacy_accepted?: number | boolean;
  consent_version?: string | null;
}

const signToken = (user: User) =>
  jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    process.env.JWT_SECRET!,
    { expiresIn: '7d' }
  );

const frontendBase = () => process.env.FRONTEND_URL || 'http://localhost:3000';
const apiBase = (req: Request) => {
  if (process.env.API_BASE_URL) return process.env.API_BASE_URL;
  const forwardedProto = req.headers['x-forwarded-proto']?.toString().split(',')[0]?.trim();
  const proto = forwardedProto || req.protocol;
  return `${proto}://${req.get('host')}`;
};

const randomPasswordHash = async () => bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);

const signOauthState = (
  provider: string,
  role: string,
  verifier?: string,
  termsAccepted?: boolean,
  privacyAccepted?: boolean,
  consentVersion?: string
) =>
  jwt.sign(
    {
      provider,
      role,
      verifier,
      termsAccepted: Boolean(termsAccepted),
      privacyAccepted: Boolean(privacyAccepted),
      consentVersion: consentVersion || '2026-03',
      nonce: crypto.randomUUID(),
    },
    process.env.JWT_SECRET!,
    { expiresIn: '10m' }
  );

const verifyOauthState = (token: string) =>
  jwt.verify(token, process.env.JWT_SECRET!) as {
    provider: string;
    role: string;
    verifier?: string;
    termsAccepted?: boolean;
    privacyAccepted?: boolean;
    consentVersion?: string;
  };

const redirectOauthSuccess = (res: Response, user: User) => {
  const token = signToken(user);
  const payload = Buffer.from(JSON.stringify({
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    avatar: user.avatar,
  })).toString('base64url');
  res.redirect(`${frontendBase()}/oauth/callback?token=${encodeURIComponent(token)}&user=${encodeURIComponent(payload)}`);
};

const redirectOauthError = (res: Response, error: string) => {
  res.redirect(`${frontendBase()}/oauth/callback?error=${encodeURIComponent(error)}`);
};

const findOrCreateOauthUser = async (params: {
  email?: string;
  name: string;
  avatar?: string | null;
  role?: string;
  consentVersion?: string;
}): Promise<User> => {
  const email = (params.email || '').trim().toLowerCase();
  if (email) {
    const [existingByEmail] = await pool.query<User[]>(
      'SELECT * FROM users WHERE lower(email) = ?',
      [email]
    );
    if (existingByEmail[0]) return existingByEmail[0];
  }

  const id = uuidv4();
  const hashed = await randomPasswordHash();
  const role = params.role === 'organizer' ? 'organizer' : 'user';
  const fallbackEmail = email || `user-${id}@oauth.eventmagic.local`;
  const consentVersion = params.consentVersion || '2026-03';
  await pool.query(
    `INSERT INTO users
      (id, name, email, password, role, avatar, terms_accepted, privacy_accepted, consented_at, consent_version)
     VALUES (?, ?, ?, ?, ?, ?, FALSE, FALSE, NULL, ?)`,
    [id, params.name || 'User', fallbackEmail, hashed, role, params.avatar || null, consentVersion]
  );
  const [rows] = await pool.query<User[]>('SELECT * FROM users WHERE id = ?', [id]);
  return rows[0];
};

const base64UrlSha256 = (input: string) =>
  crypto.createHash('sha256').update(input).digest('base64url');

const trackSuccessfulLogin = async (req: Request, user: User, action: string) => {
  const ip = requestIp(req.headers['x-forwarded-for'], req.socket.remoteAddress);
  const ua = req.headers['user-agent']?.toString() || null;
  await pool.query('UPDATE users SET last_login_at = NOW(), last_login_ip = ? WHERE id = ?', [ip, user.id]);
  await logSecurityActivity({
    user_id: user.id,
    email: user.email,
    action,
    endpoint: req.originalUrl,
    method: req.method,
    success: true,
    ip_address: ip,
    user_agent: ua,
  });
};

export const register = async (req: Request, res: Response): Promise<void> => {
  const { name, email, password, role, terms_accepted, privacy_accepted, consent_version } = req.body;
  try {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    if (!name || !normalizedEmail || !password) {
      res.status(400).json({ error: 'Name, email and password are required' });
      return;
    }
    if (!terms_accepted || !privacy_accepted) {
      res.status(400).json({ error: 'Terms and Privacy consent is required' });
      return;
    }
    const [existing] = await pool.query<User[]>('SELECT id FROM users WHERE lower(email) = ?', [normalizedEmail]);
    if (existing.length > 0) {
      res.status(409).json({ error: 'Email already registered' });
      return;
    }

    const hashed = await bcrypt.hash(password, 12);
    const id = uuidv4();
    const userRole = (role === 'user' || role === 'organizer') ? role : 'user';

    try {
      await pool.query(
        `INSERT INTO users
          (id, name, email, password, role, terms_accepted, privacy_accepted, consented_at, consent_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), ?)`,
        [id, name, normalizedEmail, hashed, userRole, true, true, consent_version || '2026-03']
      );
    } catch (insertErr: unknown) {
      // Backward compatibility for older DB schema without consent columns.
      const code = (insertErr as { code?: string })?.code;
      if (code !== 'ER_BAD_FIELD_ERROR') throw insertErr;
      await pool.query(
        `INSERT INTO users (id, name, email, password, role)
         VALUES (?, ?, ?, ?, ?)`,
        [id, name, normalizedEmail, hashed, userRole]
      );
    }
    const ip = req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim() || req.socket.remoteAddress || null;
    const ua = req.headers['user-agent']?.toString() || null;
    try {
      await pool.query(
        `INSERT INTO consent_events (user_id, consent_type, policy_version, accepted, source, ip_address, user_agent)
         VALUES (?, 'terms', ?, TRUE, 'register', ?, ?), (?, 'privacy', ?, TRUE, 'register', ?, ?)`,
        [id, consent_version || '2026-03', ip, ua, id, consent_version || '2026-03', ip, ua]
      );
    } catch {
      // consent_events table may not exist in older deployments; skip hard-fail.
    }

    const [rows] = await pool.query<User[]>('SELECT * FROM users WHERE id = ?', [id]);
    const user = rows[0];
    const token = signToken(user);

    res.status(201).json({
      token,
      user: { id: user.id, name: user.name, email: user.email, role: user.role, avatar: user.avatar },
    });
  } catch (err) {
    logger.error({ err }, 'auth_register_failed');
    res.status(500).json({ error: 'Registration failed' });
  }
};

export const login = async (req: Request, res: Response): Promise<void> => {
  const { email, password } = req.body;
  const ip = requestIp(req.headers['x-forwarded-for'], req.socket.remoteAddress);
  const ua = req.headers['user-agent']?.toString() || null;
  try {
    const stripInvisible = (v: string) => v.replace(/[\u200B-\u200D\uFEFF]/g, '');
    const normalizedEmail = stripInvisible(String(email || '').normalize('NFKC')).trim().toLowerCase();
    const rawPassword = String(password || '');
    const normalizedPassword = stripInvisible(rawPassword.normalize('NFKC'));
    const trimmedPassword = normalizedPassword.trim();
    const noLineBreakPassword = normalizedPassword.replace(/[\r\n]/g, '');
    if (!normalizedEmail || !rawPassword) {
      await logSecurityActivity({
        email: normalizedEmail || null,
        action: 'login_failed',
        endpoint: req.originalUrl,
        method: req.method,
        success: false,
        ip_address: ip,
        user_agent: ua,
        metadata: { reason: 'missing_credentials' },
      });
      res.status(400).json({ error: 'Email and password are required' });
      return;
    }

    const [rows] = await pool.query<User[]>('SELECT * FROM users WHERE lower(email) = ?', [normalizedEmail]);
    const user = rows[0];

    const passwordCandidates = Array.from(new Set([
      rawPassword,
      normalizedPassword,
      trimmedPassword,
      noLineBreakPassword,
    ])).filter(Boolean);
    let isValidPassword = false;
    if (user) {
      for (const candidate of passwordCandidates) {
        if (await bcrypt.compare(candidate, user.password)) {
          isValidPassword = true;
          break;
        }
      }
    }

    if (!user || !isValidPassword) {
      await logSecurityActivity({
        email: normalizedEmail,
        action: 'login_failed',
        endpoint: req.originalUrl,
        method: req.method,
        success: false,
        ip_address: ip,
        user_agent: ua,
        metadata: { reason: 'invalid_credentials' },
      });
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }
    if (user.status === 'blocked') {
      await logSecurityActivity({
        user_id: user.id,
        email: user.email,
        action: 'login_blocked',
        endpoint: req.originalUrl,
        method: req.method,
        success: false,
        ip_address: ip,
        user_agent: ua,
      });
      res.status(403).json({ error: 'Account is blocked' });
      return;
    }

    await trackSuccessfulLogin(req, user, 'login_success');

    const token = signToken(user);
    res.json({
      token,
      user: { id: user.id, name: user.name, email: user.email, role: user.role, avatar: user.avatar },
    });
  } catch (err) {
    logger.error({ err }, 'auth_login_failed');
    res.status(500).json({ error: 'Login failed' });
  }
};

export const getMe = async (req: Request & { user?: { id: string } }, res: Response): Promise<void> => {
  try {
    const [rows] = await pool.query<User[]>(
      'SELECT id, name, email, role, avatar, created_at, terms_accepted, privacy_accepted, consent_version FROM users WHERE id = ?',
      [req.user!.id]
    );
    if (!rows[0]) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    res.json(rows[0]);
  } catch (err) {
    logger.error({ err }, 'auth_get_me_failed');
    res.status(500).json({ error: 'Failed to fetch user' });
  }
};

export const updateProfile = async (req: Request & { user?: { id: string } }, res: Response): Promise<void> => {
  const { name, avatar } = req.body;
  try {
    await pool.query('UPDATE users SET name = ?, avatar = ? WHERE id = ?', [name, avatar, req.user!.id]);
    const [rows] = await pool.query<User[]>(
      'SELECT id, name, email, role, avatar FROM users WHERE id = ?',
      [req.user!.id]
    );
    res.json(rows[0]);
  } catch (err) {
    logger.error({ err }, 'auth_update_profile_failed');
    res.status(500).json({ error: 'Failed to update profile' });
  }
};

export const oauthStart = async (req: Request, res: Response): Promise<void> => {
  const provider = String(req.params.provider || '').toLowerCase();
  const role = String(req.query.role || 'user').toLowerCase();
  const termsAccepted = String(req.query.terms_accepted || '') === '1' || String(req.query.terms_accepted || '').toLowerCase() === 'true';
  const privacyAccepted = String(req.query.privacy_accepted || '') === '1' || String(req.query.privacy_accepted || '').toLowerCase() === 'true';
  const consentVersion = String(req.query.consent_version || '2026-03');
  try {
    if (provider === 'google') {
      if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
        redirectOauthError(res, 'Google SSO is not configured');
        return;
      }
      const state = signOauthState(provider, role, undefined, termsAccepted, privacyAccepted, consentVersion);
      const redirectUri = `${apiBase(req)}/api/auth/oauth/google/callback`;
      const params = new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID || '',
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'openid email profile',
        state,
        prompt: 'select_account',
      });
      res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
      return;
    }

    if (provider === 'linkedin') {
      const state = signOauthState(provider, role, undefined, termsAccepted, privacyAccepted, consentVersion);
      const redirectUri = `${apiBase(req)}/api/auth/oauth/linkedin/callback`;
      const params = new URLSearchParams({
        response_type: 'code',
        client_id: process.env.LINKEDIN_CLIENT_ID || '',
        redirect_uri: redirectUri,
        scope: 'openid profile email',
        state,
      });
      res.redirect(`https://www.linkedin.com/oauth/v2/authorization?${params.toString()}`);
      return;
    }

    if (provider === 'x') {
      const verifier = crypto.randomBytes(48).toString('base64url');
      const state = signOauthState(provider, role, verifier, termsAccepted, privacyAccepted, consentVersion);
      const redirectUri = `${apiBase(req)}/api/auth/oauth/x/callback`;
      const params = new URLSearchParams({
        response_type: 'code',
        client_id: process.env.X_CLIENT_ID || '',
        redirect_uri: redirectUri,
        scope: 'tweet.read users.read offline.access',
        state,
        code_challenge: base64UrlSha256(verifier),
        code_challenge_method: 'S256',
      });
      res.redirect(`https://twitter.com/i/oauth2/authorize?${params.toString()}`);
      return;
    }

    res.status(400).json({ error: 'Unsupported provider' });
  } catch (err) {
    logger.error({ err }, 'auth_oauth_start_failed');
    res.status(500).json({ error: 'Failed to start OAuth' });
  }
};

export const oauthCallback = async (req: Request, res: Response): Promise<void> => {
  const provider = String(req.params.provider || '').toLowerCase();
  const code = String(req.query.code || '');
  const state = String(req.query.state || '');
  try {
    if (!code || !state) {
      redirectOauthError(res, 'Missing OAuth parameters');
      return;
    }
    const verified = verifyOauthState(state);
    if (verified.provider !== provider) {
      redirectOauthError(res, 'Invalid OAuth state');
      return;
    }

    if (provider === 'google') {
      if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
        redirectOauthError(res, 'Google SSO is not configured');
        return;
      }
      const redirectUri = `${apiBase(req)}/api/auth/oauth/google/callback`;
      const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: process.env.GOOGLE_CLIENT_ID || '',
          client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        }),
      });
      const tokenData = await tokenResp.json() as { access_token?: string };
      if (!tokenData.access_token) {
        redirectOauthError(res, 'Google token exchange failed');
        return;
      }
      const profileResp = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      const profile = await profileResp.json() as { email?: string; name?: string; picture?: string };
      const user = await findOrCreateOauthUser({
        email: profile.email,
        name: profile.name || 'Google User',
        avatar: profile.picture || null,
        role: verified.role,
        consentVersion: verified.consentVersion,
      });
      await trackSuccessfulLogin(req, user, 'oauth_login_success_google');
      redirectOauthSuccess(res, user);
      return;
    }

    if (provider === 'linkedin') {
      const redirectUri = `${apiBase(req)}/api/auth/oauth/linkedin/callback`;
      const tokenResp = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          client_id: process.env.LINKEDIN_CLIENT_ID || '',
          client_secret: process.env.LINKEDIN_CLIENT_SECRET || '',
        }),
      });
      const tokenData = await tokenResp.json() as { access_token?: string };
      if (!tokenData.access_token) {
        redirectOauthError(res, 'LinkedIn token exchange failed');
        return;
      }
      const profileResp = await fetch('https://api.linkedin.com/v2/userinfo', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      const profile = await profileResp.json() as { email?: string; name?: string; picture?: string };
      const user = await findOrCreateOauthUser({
        email: profile.email,
        name: profile.name || 'LinkedIn User',
        avatar: profile.picture || null,
        role: verified.role,
        consentVersion: verified.consentVersion,
      });
      await trackSuccessfulLogin(req, user, 'oauth_login_success_linkedin');
      redirectOauthSuccess(res, user);
      return;
    }

    if (provider === 'x') {
      const redirectUri = `${apiBase(req)}/api/auth/oauth/x/callback`;
      const tokenResp = await fetch('https://api.twitter.com/2/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          grant_type: 'authorization_code',
          client_id: process.env.X_CLIENT_ID || '',
          client_secret: process.env.X_CLIENT_SECRET || '',
          redirect_uri: redirectUri,
          code_verifier: verified.verifier || '',
        }),
      });
      const tokenData = await tokenResp.json() as { access_token?: string };
      if (!tokenData.access_token) {
        redirectOauthError(res, 'X token exchange failed');
        return;
      }
      const profileResp = await fetch('https://api.twitter.com/2/users/me?user.fields=profile_image_url,name,username', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      const profileData = await profileResp.json() as {
        data?: { id?: string; name?: string; username?: string; profile_image_url?: string };
      };
      const xUser = profileData.data || {};
      const user = await findOrCreateOauthUser({
        email: xUser.username ? `${xUser.username}@x.oauth.eventmagic.local` : undefined,
        name: xUser.name || xUser.username || 'X User',
        avatar: xUser.profile_image_url || null,
        role: verified.role,
        consentVersion: verified.consentVersion,
      });
      await trackSuccessfulLogin(req, user, 'oauth_login_success_x');
      redirectOauthSuccess(res, user);
      return;
    }

    redirectOauthError(res, 'Unsupported provider');
  } catch (err) {
    logger.error({ err }, 'auth_oauth_callback_failed');
    redirectOauthError(res, 'OAuth callback failed');
  }
};

export const acceptConsent = async (req: Request & { user?: { id: string } }, res: Response): Promise<void> => {
  const { terms_accepted, privacy_accepted, consent_version } = req.body as {
    terms_accepted?: boolean;
    privacy_accepted?: boolean;
    consent_version?: string;
  };
  if (!terms_accepted || !privacy_accepted) {
    res.status(400).json({ error: 'Both Terms and Privacy consent are required' });
    return;
  }
  try {
    await pool.query(
      `UPDATE users
       SET terms_accepted = TRUE,
           privacy_accepted = TRUE,
           consented_at = NOW(),
           consent_version = ?
       WHERE id = ?`,
      [consent_version || '2026-03', req.user!.id]
    );
    try {
      const ip = req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim() || req.socket.remoteAddress || null;
      const ua = req.headers['user-agent']?.toString() || null;
      await pool.query(
        `INSERT INTO consent_events (user_id, consent_type, policy_version, accepted, source, ip_address, user_agent)
         VALUES (?, 'terms', ?, TRUE, 'dashboard_modal', ?, ?), (?, 'privacy', ?, TRUE, 'dashboard_modal', ?, ?)`,
        [req.user!.id, consent_version || '2026-03', ip, ua, req.user!.id, consent_version || '2026-03', ip, ua]
      );
    } catch {
      // optional in legacy envs
    }
    const [rows] = await pool.query<User[]>(
      'SELECT id, name, email, role, avatar, terms_accepted, privacy_accepted, consent_version FROM users WHERE id = ?',
      [req.user!.id]
    );
    res.json(rows[0]);
  } catch (err) {
    logger.error({ err }, 'auth_accept_consent_failed');
    res.status(500).json({ error: 'Failed to save consent' });
  }
};
