import { Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { sendEmail, rsvpConfirmationTemplate } from '../utils/emailService';
import pool from '../utils/db';
import { RowDataPacket } from 'mysql2';
import { AuthRequest } from '../middleware/auth';

interface RSVP extends RowDataPacket {
  id: string;
  event_id: string;
  user_id: string;
  status: string;
  ticket_code: string;
  phone?: string | null;
  contact_email?: string | null;
  notification_consent?: number | null;
}

const generateTicketCode = () =>
  'TVT-' + Math.random().toString(36).substring(2, 8).toUpperCase();

const normalizePhone = (phone?: string | null): string | null => {
  if (!phone) return null;
  const digits = String(phone).replace(/[^0-9]/g, '');
  return digits.length >= 8 ? digits : null;
};

const normalizeEmail = (email?: string | null): string | null => {
  if (!email) return null;
  const out = String(email).trim().toLowerCase();
  return /.+@.+\..+/.test(out) ? out : null;
};

async function sendWhatsAppText(to: string, message: string): Promise<void> {
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
  if (!resp.ok) throw new Error(`WhatsApp send failed (${resp.status})`);
}

async function notifyRsvpGoing(params: {
  eventId: string;
  userId: string;
  contactEmail?: string | null;
  phone?: string | null;
  ticketCode: string;
}): Promise<string[]> {
  const warnings: string[] = [];
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT e.id, e.title, e.start_date, e.end_date, e.venue_name, e.venue_address, e.city, e.is_online, e.online_link,
            u.email AS user_email, u.name AS user_name,
            host.name AS organizer_name
     FROM events e
     JOIN users u ON u.id = ?
     LEFT JOIN users host ON host.id = e.organizer_id
     WHERE e.id = ?
     LIMIT 1`,
    [params.userId, params.eventId]
  );
  const row = rows[0];
  if (!row) return warnings;

  const appUrl = process.env.FRONTEND_URL || 'https://host-events.appsmagic.in';
  const eventUrl = `${appUrl}/events/${params.eventId}`;
  const shortEventId = String(row.id).replace(/-/g, '').slice(0, 8).toUpperCase();
  const joinUrl = `${appUrl}/e/${shortEventId}?code=${encodeURIComponent(params.ticketCode)}`;
  const joinManualUrl = `${appUrl}/e/${shortEventId}`;
  const emailTo = normalizeEmail(params.contactEmail || (row.user_email as string));
  const phone = normalizePhone(params.phone);

  if (emailTo) {
    try {
      await sendEmail(
        emailTo,
        `RSVP Confirmed: ${row.title}`,
        rsvpConfirmationTemplate(
          {
            title: row.title as string,
            start_date: row.start_date as string,
            end_date: (row.end_date as string) || null,
            organizer_name: (row.organizer_name as string) || null,
            venue_name: (row.venue_name as string) || '',
            venue_address: (row.venue_address as string) || null,
            city: (row.city as string) || '',
            is_online: Boolean(row.is_online),
            online_link: (row.online_link as string) || null,
            short_event_id: shortEventId,
            join_url: joinUrl,
            join_manual_url: joinManualUrl,
          },
          params.ticketCode,
          eventUrl
        )
      );
    } catch (err) {
      console.error('RSVP email notification failed:', err);
      warnings.push('email_notification_failed');
    }
  } else {
    warnings.push('missing_contact_email');
  }

  if (phone) {
    try {
      const body = [
        `RSVP confirmed for ${row.title}`,
        `Event ID: ${shortEventId}`,
        `Ticket: ${params.ticketCode}`,
        `Join: ${joinUrl}`,
        `Manual: ${joinManualUrl}`,
      ].join('\n');
      await sendWhatsAppText(phone, body);
    } catch (err) {
      console.error('RSVP WhatsApp notification failed:', err);
      warnings.push('whatsapp_notification_failed');
    }
  } else {
    warnings.push('missing_phone_for_whatsapp');
  }

  return warnings;
}

async function ensureRsvpConsentColumns() {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT COLUMN_NAME
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'rsvps'
       AND COLUMN_NAME IN ('notification_consent', 'notification_consent_at')`
  );
  const existing = new Set(rows.map((r) => String(r.COLUMN_NAME)));
  if (!existing.has('notification_consent')) {
    await pool.query('ALTER TABLE rsvps ADD COLUMN notification_consent BOOLEAN DEFAULT FALSE');
  }
  if (!existing.has('notification_consent_at')) {
    await pool.query('ALTER TABLE rsvps ADD COLUMN notification_consent_at DATETIME NULL');
  }
}

export const rsvpEvent = async (req: AuthRequest, res: Response): Promise<void> => {
  const { status = 'going', phone, contact_email, notes, notification_consent } = req.body;
  const eventId = req.params.id;

  try {
    await ensureRsvpConsentColumns();
    const [events] = await pool.query<RowDataPacket[]>(
      `SELECT id, max_attendees, current_attendees, registration_deadline, status
       FROM events WHERE id = ?`,
      [eventId]
    );

    const event = events[0];
    if (!event || event.status !== 'published') {
      res.status(404).json({ error: 'Event not found or not available' });
      return;
    }

    if (event.registration_deadline && new Date(event.registration_deadline) < new Date()) {
      res.status(400).json({ error: 'Registration deadline has passed' });
      return;
    }

    if (
      event.max_attendees &&
      event.current_attendees >= event.max_attendees &&
      status === 'going'
    ) {
      res.status(400).json({ error: 'Event is full' });
      return;
    }

    const [existing] = await pool.query<RSVP[]>(
      'SELECT * FROM rsvps WHERE event_id = ? AND user_id = ?',
      [eventId, req.user!.id]
    );
    const normalizedPhone = normalizePhone(phone || null);
    const normalizedContactEmail = normalizeEmail(contact_email || null);

    if (existing.length > 0) {
      const previousStatus = existing[0].status;
      const effectivePhone = normalizedPhone || normalizePhone(existing[0].phone || null);
      const effectiveEmail = normalizedContactEmail || normalizeEmail(existing[0].contact_email || null);
      const shouldNotify = status === 'going' && previousStatus !== 'going';
      const ticketCode = existing[0].ticket_code || (status === 'going' ? generateTicketCode() : null);
      const hasNotificationConsent = Boolean(notification_consent) || Boolean(existing[0].notification_consent);
      if (status === 'going' && !effectivePhone) {
        res.status(400).json({ error: 'Phone number is required to accept this event', code: 'phone_required' });
        return;
      }
      if (status === 'going' && !hasNotificationConsent) {
        res.status(400).json({ error: 'Notification consent is required to accept this event', code: 'notification_consent_required' });
        return;
      }
      await pool.query(
        `UPDATE rsvps
         SET status = ?,
             ticket_code = COALESCE(?, ticket_code),
             phone = COALESCE(?, phone),
             contact_email = COALESCE(?, contact_email),
             notes = COALESCE(?, notes),
             notification_consent = CASE WHEN ? THEN TRUE ELSE notification_consent END,
             notification_consent_at = CASE WHEN ? THEN NOW() ELSE notification_consent_at END
         WHERE event_id = ? AND user_id = ?`,
        [status, ticketCode, effectivePhone, effectiveEmail, notes || null, Boolean(notification_consent), Boolean(notification_consent), eventId, req.user!.id]
      );

      // Adjust attendee count
      if (previousStatus === 'going' && status !== 'going') {
        await pool.query('UPDATE events SET current_attendees = current_attendees - 1 WHERE id = ?', [eventId]);
      } else if (previousStatus !== 'going' && status === 'going') {
        await pool.query('UPDATE events SET current_attendees = current_attendees + 1 WHERE id = ?', [eventId]);
      }

      const notificationWarnings = shouldNotify && ticketCode
        ? await notifyRsvpGoing({
            eventId,
            userId: req.user!.id,
            contactEmail: effectiveEmail,
            phone: effectivePhone,
            ticketCode,
          })
        : [];

      res.json({ message: 'RSVP updated', status, ticket_code: ticketCode, notification_warnings: notificationWarnings });
      return;
    }

    const id = uuidv4();
    const ticketCode = status === 'going' ? generateTicketCode() : null;
    if (status === 'going' && !normalizedPhone) {
      res.status(400).json({ error: 'Phone number is required to accept this event', code: 'phone_required' });
      return;
    }
    if (status === 'going' && !Boolean(notification_consent)) {
      res.status(400).json({ error: 'Notification consent is required to accept this event', code: 'notification_consent_required' });
      return;
    }

    await pool.query(
      `INSERT INTO rsvps
       (id, event_id, user_id, status, ticket_code, phone, contact_email, notes, notification_consent, notification_consent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, eventId, req.user!.id, status, ticketCode, normalizedPhone, normalizedContactEmail, notes || null, Boolean(notification_consent), Boolean(notification_consent) ? new Date() : null]
    );

    if (status === 'going') {
      await pool.query('UPDATE events SET current_attendees = current_attendees + 1 WHERE id = ?', [eventId]);
    }

    const notificationWarnings = status === 'going' && ticketCode
      ? await notifyRsvpGoing({
          eventId,
          userId: req.user!.id,
          contactEmail: normalizedContactEmail,
          phone: normalizedPhone,
          ticketCode,
        })
      : [];

    res.status(201).json({ message: 'RSVP created', status, ticket_code: ticketCode, notification_warnings: notificationWarnings });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to RSVP' });
  }
};

export const getMyRSVPs = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT r.*, e.title, e.start_date, e.end_date, e.city, e.venue_name,
              e.banner_url, e.is_online, e.online_link, c.name AS category_name, c.icon AS category_icon
       FROM rsvps r
       JOIN events e ON r.event_id = e.id
       LEFT JOIN categories c ON e.category_id = c.id
       WHERE r.user_id = ?
       ORDER BY e.start_date ASC`,
      [req.user!.id]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch RSVPs' });
  }
};

export const getEventAttendees = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const [events] = await pool.query<RowDataPacket[]>(
      'SELECT organizer_id FROM events WHERE id = ?',
      [req.params.id]
    );

    if (!events[0]) {
      res.status(404).json({ error: 'Event not found' });
      return;
    }

    if (events[0].organizer_id !== req.user!.id && req.user!.role !== 'admin') {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT r.id, r.status, r.ticket_code, r.checked_in, r.checked_in_at, r.created_at,
              u.name, u.email, u.avatar
       FROM rsvps r
       JOIN users u ON r.user_id = u.id
       WHERE r.event_id = ?
       ORDER BY r.created_at ASC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch attendees' });
  }
};

export const checkIn = async (req: AuthRequest, res: Response): Promise<void> => {
  const { ticket_code } = req.body;
  try {
    const [rows] = await pool.query<RSVP[]>(
      `SELECT r.*, e.organizer_id FROM rsvps r
       JOIN events e ON r.event_id = e.id
       WHERE r.ticket_code = ? AND r.event_id = ?`,
      [ticket_code, req.params.id]
    );

    if (!rows[0]) {
      res.status(404).json({ error: 'Ticket not found' });
      return;
    }

    if (rows[0].checked_in) {
      res.status(400).json({ error: 'Already checked in' });
      return;
    }

    await pool.query(
      'UPDATE rsvps SET checked_in = TRUE, checked_in_at = NOW() WHERE ticket_code = ?',
      [ticket_code]
    );

    res.json({ message: 'Checked in successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to check in' });
  }
};

export const getMyStatus = async (req: AuthRequest, res: Response): Promise<void> => {
  const eventId = req.params.id;
  try {
    await ensureRsvpConsentColumns();
    const [rsvpRows] = await pool.query<RowDataPacket[]>(
      `SELECT status, ticket_code, phone, contact_email,
              COALESCE(notification_consent, 0) AS notification_consent
       FROM rsvps
       WHERE event_id = ? AND user_id = ?`,
      [eventId, req.user!.id]
    );
    const [recentRows] = await pool.query<RowDataPacket[]>(
      `SELECT phone, contact_email, COALESCE(notification_consent, 0) AS notification_consent
       FROM rsvps
       WHERE user_id = ? AND (phone IS NOT NULL OR contact_email IS NOT NULL)
       ORDER BY created_at DESC
       LIMIT 1`,
      [req.user!.id]
    );
    const [likeRows] = await pool.query<RowDataPacket[]>(
      'SELECT id FROM event_likes WHERE event_id = ? AND user_id = ?',
      [eventId, req.user!.id]
    );
    const eventRsvp = rsvpRows[0] || null;
    const recentRsvp = recentRows[0] || null;
    const prefillPhone = normalizePhone((eventRsvp?.phone as string) || (recentRsvp?.phone as string) || null);
    const prefillEmail = normalizeEmail((eventRsvp?.contact_email as string) || (recentRsvp?.contact_email as string) || null);
    const notificationConsent = Boolean(
      Number(eventRsvp?.notification_consent || recentRsvp?.notification_consent || 0)
    );

    res.json({
      rsvpStatus: eventRsvp?.status ?? null,
      ticketCode: eventRsvp?.ticket_code ?? null,
      prefillPhone,
      prefillEmail,
      notificationConsent,
      liked: likeRows.length > 0,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch status' });
  }
};

export const joinEventWithCode = async (req: AuthRequest, res: Response): Promise<void> => {
  const rawEventId = String(req.params.id || '').trim();
  const shortCode = rawEventId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toUpperCase();
  const joinCode = String(req.body?.join_code || '').trim().toUpperCase();

  try {
    const [events] = await pool.query<RowDataPacket[]>(
      `SELECT id, title, status, event_started, is_online, online_link, start_date
       FROM events
       WHERE id = ? OR UPPER(LEFT(REPLACE(id, '-', ''), 8)) = ?
       LIMIT 1`,
      [rawEventId, shortCode]
    );
    const event = events[0];
    if (!event) {
      res.status(404).json({ error: 'Event not found' });
      return;
    }
    if (!event.is_online || !event.online_link) {
      res.status(400).json({ error: 'This event has no online meeting link' });
      return;
    }
    if (event.status !== 'published' || !event.event_started) {
      res.status(400).json({ error: 'Event not started. Host needs to start the event.' });
      return;
    }
    if (!joinCode) {
      res.status(400).json({ error: 'Join code is required' });
      return;
    }

    const [rsvps] = await pool.query<RowDataPacket[]>(
      `SELECT id, checked_in
       FROM rsvps
       WHERE event_id = ? AND ticket_code = ? AND status = 'going'`,
      [event.id, joinCode]
    );
    const rsvp = rsvps[0];
    if (!rsvp) {
      res.status(400).json({ error: 'Invalid join code for this event' });
      return;
    }

    if (!rsvp.checked_in) {
      await pool.query('UPDATE rsvps SET checked_in = TRUE, checked_in_at = NOW() WHERE id = ?', [rsvp.id]);
    }

    res.json({
      ok: true,
      join_url: event.online_link,
      checked_in: true,
      event_title: event.title,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to join event' });
  }
};

export const joinWaitlist = async (req: AuthRequest, res: Response): Promise<void> => {
  const eventId = req.params.id;
  try {
    const [existing] = await pool.query<RowDataPacket[]>(
      'SELECT id FROM waitlist WHERE event_id = ? AND user_id = ?',
      [eventId, req.user!.id]
    );
    if (existing.length > 0) { res.status(400).json({ error: 'Already on waitlist' }); return; }
    const [[{ pos }]] = await pool.query<RowDataPacket[]>(
      'SELECT COALESCE(MAX(position),0)+1 AS pos FROM waitlist WHERE event_id = ?', [eventId]
    );
    await pool.query(
      'INSERT INTO waitlist (id, event_id, user_id, position) VALUES (?, ?, ?, ?)',
      [uuidv4(), eventId, req.user!.id, pos]
    );
    await pool.query('UPDATE events SET waitlist_count = waitlist_count + 1 WHERE id = ?', [eventId]);
    res.status(201).json({ message: 'Added to waitlist', position: pos });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to join waitlist' });
  }
};

export const leaveWaitlist = async (req: AuthRequest, res: Response): Promise<void> => {
  const eventId = req.params.id;
  try {
    const [result] = await pool.query(
      'DELETE FROM waitlist WHERE event_id = ? AND user_id = ?', [eventId, req.user!.id]
    );
    if ((result as { affectedRows: number }).affectedRows > 0) {
      await pool.query('UPDATE events SET waitlist_count = GREATEST(0, waitlist_count - 1) WHERE id = ?', [eventId]);
    }
    res.json({ message: 'Removed from waitlist' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to leave waitlist' });
  }
};

export const getWaitlistPosition = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT position FROM waitlist WHERE event_id = ? AND user_id = ?',
      [req.params.id, req.user!.id]
    );
    res.json({ position: rows[0]?.position ?? null });
  } catch (err) {
    res.status(500).json({ error: 'Failed' });
  }
};

export const getPublicAttendees = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    // Check if organiser has enabled public attendee list
    const [[event]] = await pool.query<RowDataPacket[]>(
      'SELECT show_attendees_public, organizer_id FROM events WHERE id = ?',
      [req.params.id]
    );
    if (!event) { res.status(404).json({ error: 'Event not found' }); return; }

    // Only block if explicitly disabled (0). Default (1 or null) = public.
    if (event.show_attendees_public === 0) {
      res.status(403).json({ error: 'Attendee list is private for this event' });
      return;
    }

    const limit = Math.min(parseInt(req.query.limit as string) || 20, 50);
    const offset = parseInt(req.query.offset as string) || 0;

    const [[{ total }]] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS total FROM rsvps WHERE event_id = ? AND status = 'going'`,
      [req.params.id]
    );

    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT u.id, u.name, u.avatar
       FROM rsvps r
       JOIN users u ON r.user_id = u.id
       WHERE r.event_id = ? AND r.status = 'going'
       ORDER BY r.created_at ASC
       LIMIT ? OFFSET ?`,
      [req.params.id, limit, offset]
    );
    res.json({ data: rows, total, limit, offset, hasMore: offset + limit < total });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch attendees' });
  }
};
