import pool from './db';

export async function logSecurityActivity(params: {
  user_id?: string | null;
  email?: string | null;
  action: string;
  endpoint?: string | null;
  method?: string | null;
  success?: boolean;
  ip_address?: string | null;
  user_agent?: string | null;
  metadata?: unknown;
}): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO security_activity_logs
        (user_id, email, action, endpoint, method, success, ip_address, user_agent, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        params.user_id ?? null,
        params.email ?? null,
        params.action,
        params.endpoint ?? null,
        params.method ?? null,
        params.success !== false,
        params.ip_address ?? null,
        params.user_agent ?? null,
        params.metadata ? JSON.stringify(params.metadata) : null,
      ]
    );
  } catch {
    // Security logging should never break request flow.
  }
}

export function requestIp(ipHeader: string | string[] | undefined, socketIp: string | undefined): string | null {
  if (Array.isArray(ipHeader)) return ipHeader[0] || socketIp || null;
  if (typeof ipHeader === 'string' && ipHeader.trim()) return ipHeader.split(',')[0].trim();
  return socketIp || null;
}
