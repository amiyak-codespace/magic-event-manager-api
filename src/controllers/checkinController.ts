import { Request, Response } from 'express';
import db from '../utils/db';

export async function getCheckinDashboard(req: Request, res: Response) {
  const { eventId } = req.params;
  const user = (req as any).user;
  const [[event]] = await db.query<any[]>('SELECT id, title, organizer_id, max_attendees, current_attendees FROM events WHERE id = ?', [eventId]);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  if (event.organizer_id !== user.id && user.role !== 'admin') return res.status(403).json({ error: 'Not authorized' });

  const [attendees] = await db.query<any[]>(
    `SELECT r.id, r.ticket_code, r.status, r.checked_in, r.checked_in_at, r.ticket_type_id,
            u.name, u.email, u.avatar, r.contact_email, r.phone,
            tt.name as ticket_type_name
     FROM rsvps r
     LEFT JOIN users u ON u.id = r.user_id
     LEFT JOIN ticket_types tt ON tt.id = r.ticket_type_id
     WHERE r.event_id = ? AND r.status = 'going'
     ORDER BY r.checked_in DESC, u.name`,
    [eventId]
  );
  const checked_in_count = attendees.filter(a => a.checked_in).length;
  res.json({ event, attendees, stats: { total: attendees.length, checked_in: checked_in_count, pending: attendees.length - checked_in_count } });
}

export async function checkInByCode(req: Request, res: Response) {
  const { eventId } = req.params;
  const user = (req as any).user;
  const { ticket_code } = req.body;
  if (!ticket_code) return res.status(400).json({ error: 'ticket_code required' });

  const [[event]] = await db.query<any[]>('SELECT organizer_id FROM events WHERE id = ?', [eventId]);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  if (event.organizer_id !== user.id && user.role !== 'admin') return res.status(403).json({ error: 'Not authorized' });

  const [[rsvp]] = await db.query<any[]>(
    `SELECT r.*, u.name, u.email, u.avatar FROM rsvps r LEFT JOIN users u ON u.id = r.user_id
     WHERE r.ticket_code = ? AND r.event_id = ?`,
    [ticket_code, eventId]
  );
  if (!rsvp) return res.status(404).json({ error: 'Ticket not found for this event' });
  if (rsvp.status !== 'going') return res.status(400).json({ error: 'Attendee is not confirmed (status: ' + rsvp.status + ')' });
  if (rsvp.checked_in) return res.status(409).json({ error: 'Already checked in', checked_in_at: rsvp.checked_in_at, name: rsvp.name });

  await db.query('UPDATE rsvps SET checked_in=1, checked_in_at=NOW() WHERE id=?', [rsvp.id]);
  res.json({ success: true, message: 'Check-in successful!', attendee: { name: rsvp.name, email: rsvp.email, avatar: rsvp.avatar, ticket_code: rsvp.ticket_code } });
}

export async function bulkExportAttendees(req: Request, res: Response) {
  const { eventId } = req.params;
  const user = (req as any).user;
  const [[event]] = await db.query<any[]>('SELECT organizer_id, title FROM events WHERE id = ?', [eventId]);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  if (event.organizer_id !== user.id && user.role !== 'admin') return res.status(403).json({ error: 'Not authorized' });

  const [rows] = await db.query<any[]>(
    `SELECT u.name, COALESCE(r.contact_email, u.email) as email, r.phone, r.status,
            r.ticket_code, tt.name as ticket_type,
            IF(r.checked_in=1,'Yes','No') as checked_in, r.checked_in_at, r.created_at
     FROM rsvps r LEFT JOIN users u ON u.id=r.user_id LEFT JOIN ticket_types tt ON tt.id=r.ticket_type_id
     WHERE r.event_id=? ORDER BY r.status, u.name`,
    [eventId]
  );
  res.json({ event_title: event.title, attendees: rows });
}
