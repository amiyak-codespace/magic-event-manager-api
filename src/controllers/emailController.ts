import { Response } from 'express';
import pool from '../utils/db';
import { RowDataPacket } from 'mysql2';
import { AuthRequest } from '../middleware/auth';
import { sendEmail, eventInviteTemplate } from '../utils/emailService';

export const sendEventInvites = async (req: AuthRequest, res: Response): Promise<void> => {
  const { id: eventId } = req.params;
  const { emails, custom_message } = req.body as { emails: string[]; custom_message?: string };

  if (!emails || !Array.isArray(emails) || emails.length === 0) {
    res.status(400).json({ error: 'Provide at least one email address' });
    return;
  }

  if (emails.length > 50) {
    res.status(400).json({ error: 'Max 50 invites per request' });
    return;
  }

  try {
    const [events] = await pool.query<RowDataPacket[]>(
      `SELECT e.*, u.name AS organizer_name
       FROM events e
       LEFT JOIN users u ON u.id = e.organizer_id
       WHERE e.id = ?`,
      [eventId]
    );

    if (!events[0]) {
      res.status(404).json({ error: 'Event not found' });
      return;
    }

    const event = events[0];

    if (event.organizer_id !== req.user!.id && req.user!.role !== 'admin') {
      res.status(403).json({ error: 'Only the organizer can send invites' });
      return;
    }

    const appUrl = process.env.FRONTEND_URL || 'https://host-events.appsmagic.in';
    const eventUrl = `${appUrl}/events/${eventId}`;
    const html = eventInviteTemplate(
      {
        ...(event as Record<string, unknown>),
        organizer_name: (event.organizer_name as string) || 'AppsMagic Host',
      } as any,
      eventUrl,
      custom_message
    );

    const normalizedEmails = Array.from(
      new Set(
        emails
          .map((email: string) => String(email || '').trim().toLowerCase())
          .filter((email: string) => /.+@.+\..+/.test(email))
      )
    ).slice(0, 50);

    const results = await Promise.allSettled(
      normalizedEmails.map((email: string) =>
        sendEmail(email, `You're invited: ${event.title} ✨`, html)
      )
    );

    const sent = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;
    const failed_reasons = results
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => String(r.reason?.message || r.reason || 'invite_send_failed'))
      .slice(0, 5);

    if (normalizedEmails.length > 0) {
      const placeholders = normalizedEmails.map(() => '?').join(', ');
      const [users] = await pool.query<RowDataPacket[]>(
        `SELECT id, email FROM users WHERE lower(email) IN (${placeholders})`,
        normalizedEmails
      );

      for (const user of users) {
        await pool.query(
          `INSERT INTO notifications (id, user_id, type, title, message, data)
           VALUES (UUID(), ?, 'event_invite', ?, ?, ?)`,
          [
            user.id,
            `You're invited: ${event.title}`,
            custom_message?.trim() || `You have a new invite for ${event.title}.`,
            JSON.stringify({
              event_id: eventId,
              event_url: `${appUrl}/events/${eventId}`,
              source: 'event_invite',
            }),
          ]
        );
      }
    }

    res.json({
      message: `Invites sent: ${sent}${failed > 0 ? `, failed: ${failed}` : ''}`,
      sent,
      failed,
      failed_reasons,
    });
  } catch (err) {
    console.error('sendEventInvites error:', err);
    res.status(500).json({ error: 'Failed to send invites' });
  }
};
