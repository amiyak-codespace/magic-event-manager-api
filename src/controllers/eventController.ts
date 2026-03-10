import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import pool from '../utils/db';
import { RowDataPacket, ResultSetHeader } from 'mysql2';
import { AuthRequest } from '../middleware/auth';

interface Event extends RowDataPacket {
  id: string;
  title: string;
  description: string;
  organizer_id: string;
  status: string;
  [key: string]: unknown;
}

type RecurrenceFrequency = 'daily' | 'weekly' | 'monthly';
type RecurrenceEndType = 'never' | 'on_date' | 'after_count';
type InviteTemplate = 'birthday' | 'wedding' | 'corporate' | 'custom';

function normalizeInviteTemplate(value: unknown): InviteTemplate {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'birthday' || raw === 'wedding' || raw === 'corporate') return raw;
  return 'custom';
}

async function assertEventAccess(eventId: string, userId: string, role?: string): Promise<Event | null> {
  const [[event]] = await pool.query<Event[]>('SELECT * FROM events WHERE id = ?', [eventId]);
  if (!event) return null;
  if (event.organizer_id !== userId && role !== 'admin') return null;
  return event;
}

function addInterval(baseDate: Date, frequency: RecurrenceFrequency, interval = 1): Date {
  const d = new Date(baseDate);
  if (frequency === 'daily') d.setDate(d.getDate() + interval);
  else if (frequency === 'weekly') d.setDate(d.getDate() + (7 * interval));
  else d.setMonth(d.getMonth() + interval);
  return d;
}

function parseDateSafe(value?: string | null): Date | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function toMysqlDateTime(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

async function createDefaultRsvpReminderCampaigns(params: {
  eventId: string;
  organizerId: string;
  title: string;
  startDateIso: string;
  enabled: boolean;
  reminder60m: boolean;
  reminder15m: boolean;
}): Promise<void> {
  if (!params.enabled) return;
  const eventStart = parseDateSafe(params.startDateIso);
  if (!eventStart) return;

  const reminders: Array<{ offsetMinutes: number; enabled: boolean; label: string }> = [
    { offsetMinutes: 60, enabled: params.reminder60m, label: '1 hour' },
    { offsetMinutes: 15, enabled: params.reminder15m, label: '15 minutes' },
  ];

  const now = Date.now();
  for (const reminder of reminders) {
    if (!reminder.enabled) continue;
    const scheduledAt = new Date(eventStart.getTime() - reminder.offsetMinutes * 60 * 1000);
    if (scheduledAt.getTime() <= now + 60_000) continue;

    const campaignId = uuidv4();
    await pool.query(
      `INSERT INTO campaigns (
         id, event_id, organizer_id, name, type, subject, message, audience,
         status, scheduled_at, total_recipients, sent_count, failed_count,
         compliance_confirmed, compliance_notes
       ) VALUES (?, ?, ?, ?, 'email', ?, ?, 'going', 'scheduled', ?, 0, 0, 0, 1, ?)`,
      [
        campaignId,
        params.eventId,
        params.organizerId,
        `Auto RSVP Reminder - ${reminder.label}`,
        `Reminder: ${params.title} starts in ${reminder.label}`,
        `Hi, just a reminder that "${params.title}" starts in ${reminder.label}. Please keep your ticket code ready and join from your event dashboard.`,
        toMysqlDateTime(scheduledAt),
        `system_auto_rsvp_reminder_${reminder.offsetMinutes}m`,
      ]
    );
  }
}

export const getEvents = async (req: Request, res: Response): Promise<void> => {
  try {
    const {
      search,
      category,
      city,
      is_free,
      is_online,
      page = '1',
      limit = '12',
      sort = 'start_date',
    } = req.query;

    const offset = (Number(page) - 1) * Number(limit);
    const conditions: string[] = ["e.status = 'published'", 'e.start_date >= NOW()', 'e.is_private = FALSE'];
    const params: unknown[] = [];

    if (search) {
      conditions.push('(e.title LIKE ? OR e.short_description LIKE ? OR e.city LIKE ?)');
      const like = `%${search}%`;
      params.push(like, like, like);
    }
    if (category) {
      conditions.push('c.slug = ?');
      params.push(category);
    }
    if (city) {
      conditions.push('e.city LIKE ?');
      params.push(`%${city}%`);
    }
    if (is_free === 'true') {
      conditions.push('e.is_free = TRUE');
    }
    if (is_online === 'true') {
      conditions.push('e.is_online = TRUE');
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const orderMap: Record<string, string> = {
      start_date: 'e.start_date ASC',
      popular: 'e.current_attendees DESC',
      recent: 'e.created_at DESC',
    };
    const orderBy = orderMap[sort as string] ?? 'e.start_date ASC';

    const [rows] = await pool.query<Event[]>(
      `SELECT e.*, c.name AS category_name, c.slug AS category_slug, c.icon AS category_icon,
              u.name AS organizer_name, u.avatar AS organizer_avatar
       FROM events e
       LEFT JOIN categories c ON e.category_id = c.id
       LEFT JOIN users u ON e.organizer_id = u.id
       ${where}
       ORDER BY ${orderBy}
       LIMIT ? OFFSET ?`,
      [...params, Number(limit), offset]
    );

    const [[{ total }]] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS total FROM events e
       LEFT JOIN categories c ON e.category_id = c.id
       ${where}`,
      params
    );

    res.json({
      events: rows,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total: Number(total),
        pages: Math.ceil(Number(total) / Number(limit)),
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch events' });
  }
};

export const getEvent = async (req: Request, res: Response): Promise<void> => {
  try {
    const rawId = String(req.params.id || '').trim();
    const shortCode = rawId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toUpperCase();
    const [rows] = await pool.query<Event[]>(
      `SELECT e.*, c.name AS category_name, c.slug AS category_slug, c.icon AS category_icon, c.color AS category_color,
              u.name AS organizer_name, u.avatar AS organizer_avatar, u.email AS organizer_email
       FROM events e
       LEFT JOIN categories c ON e.category_id = c.id
       LEFT JOIN users u ON e.organizer_id = u.id
       WHERE e.id = ? OR UPPER(LEFT(REPLACE(e.id, '-', ''), 8)) = ?
       LIMIT 1`,
      [rawId, shortCode]
    );

    if (!rows[0]) {
      res.status(404).json({ error: 'Event not found' });
      return;
    }

    const [[{ likes }]] = await pool.query<RowDataPacket[]>(
      'SELECT COUNT(*) AS likes FROM event_likes WHERE event_id = ?',
      [rows[0].id]
    );

    const short_code = String(rows[0].id).replace(/-/g, '').slice(0, 8).toUpperCase();
    res.json({ ...rows[0], likes: Number(likes), short_code });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch event' });
  }
};

export const getEventByShortCode = async (req: Request, res: Response): Promise<void> => {
  try {
    const shortCode = String(req.params.shortCode || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{6,12}$/.test(shortCode)) {
      res.status(400).json({ error: 'Invalid event code' });
      return;
    }

    const [rows] = await pool.query<Event[]>(
      `SELECT e.*, c.name AS category_name, c.slug AS category_slug, c.icon AS category_icon, c.color AS category_color,
              u.name AS organizer_name, u.avatar AS organizer_avatar, u.email AS organizer_email
       FROM events e
       LEFT JOIN categories c ON e.category_id = c.id
       LEFT JOIN users u ON e.organizer_id = u.id
       WHERE UPPER(LEFT(REPLACE(e.id, '-', ''), 8)) = ?
       LIMIT 1`,
      [shortCode.slice(0, 8)]
    );

    if (!rows[0]) {
      res.status(404).json({ error: 'Event not found' });
      return;
    }

    const [[{ likes }]] = await pool.query<RowDataPacket[]>(
      'SELECT COUNT(*) AS likes FROM event_likes WHERE event_id = ?',
      [rows[0].id]
    );

    const short_code = String(rows[0].id).replace(/-/g, '').slice(0, 8).toUpperCase();
    res.json({ ...rows[0], likes: Number(likes), short_code });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch event' });
  }
};

export const createEvent = async (req: AuthRequest, res: Response): Promise<void> => {
  const {
    title, description, short_description, category_id,
    venue_name, venue_address, city, state, country,
    start_date, end_date, registration_deadline,
    max_attendees, is_free, price, currency,
    is_online, online_link, tags, is_private,
    invite_template,
    status,
    is_recurring, recurrence_frequency, recurrence_interval,
    recurrence_end_type, recurrence_end_date, recurrence_count_limit,
    auto_rsvp_reminders, remind_before_60m, remind_before_15m,
  } = req.body;

  try {
    const id = uuidv4();
    const createStatus = status === 'published' ? 'published' : 'draft';
    await pool.query(
      `INSERT INTO events (
        id, title, description, short_description, category_id, organizer_id,
        venue_name, venue_address, city, state, country,
        start_date, end_date, registration_deadline,
        max_attendees, is_free, price, currency,
        is_online, online_link, tags, invite_template, is_private, status,
        is_recurring, recurrence_frequency, recurrence_interval, recurrence_end_type, recurrence_end_date, recurrence_count_limit
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, title, description, short_description, category_id, req.user!.id,
        venue_name, venue_address, city, state, country || 'India',
        start_date, end_date, registration_deadline || null,
        max_attendees || null, is_free ?? true, price || 0, currency || 'INR',
        is_online ?? false, online_link || null, tags || null, normalizeInviteTemplate(invite_template), is_private ?? false, createStatus,
        Boolean(is_recurring),
        is_recurring ? recurrence_frequency || 'weekly' : null,
        is_recurring ? Math.max(1, Number(recurrence_interval) || 1) : 1,
        is_recurring ? recurrence_end_type || 'never' : 'never',
        is_recurring && recurrence_end_type === 'on_date' ? recurrence_end_date || null : null,
        is_recurring && recurrence_end_type === 'after_count' ? Math.max(1, Number(recurrence_count_limit) || 1) : null,
      ]
    );

    if (createStatus === 'published') {
      await createDefaultRsvpReminderCampaigns({
        eventId: id,
        organizerId: req.user!.id,
        title: String(title || 'Your event'),
        startDateIso: String(start_date || ''),
        enabled: auto_rsvp_reminders !== false,
        reminder60m: remind_before_60m !== false,
        reminder15m: remind_before_15m !== false,
      });
    }

    const [rows] = await pool.query<Event[]>('SELECT * FROM events WHERE id = ?', [id]);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create event' });
  }
};

export const updateEvent = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const [rows] = await pool.query<Event[]>('SELECT * FROM events WHERE id = ?', [req.params.id]);
    if (!rows[0]) {
      res.status(404).json({ error: 'Event not found' });
      return;
    }
    if (rows[0].organizer_id !== req.user!.id && req.user!.role !== 'admin') {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    const fields = [
      'title', 'description', 'short_description', 'category_id',
      'venue_name', 'venue_address', 'city', 'state', 'country',
      'start_date', 'end_date', 'registration_deadline',
      'max_attendees', 'is_free', 'price', 'currency',
      'is_online', 'online_link', 'tags', 'invite_template', 'is_private', 'status', 'banner_url',
      'is_recurring', 'recurrence_frequency', 'recurrence_interval', 'recurrence_end_type', 'recurrence_end_date', 'recurrence_count_limit',
    ];

    const updates: string[] = [];
    const values: unknown[] = [];

    for (const field of fields) {
      if (req.body[field] !== undefined) {
        updates.push(`${field} = ?`);
        if (field === 'invite_template') values.push(normalizeInviteTemplate(req.body[field]));
        else values.push(req.body[field]);
      }
    }

    if (updates.length === 0) {
      res.status(400).json({ error: 'No fields to update' });
      return;
    }

    values.push(req.params.id);
    await pool.query(`UPDATE events SET ${updates.join(', ')} WHERE id = ?`, values);

    const [updated] = await pool.query<Event[]>('SELECT * FROM events WHERE id = ?', [req.params.id]);
    res.json(updated[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update event' });
  }
};

export const cloneEvent = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const source = await assertEventAccess(req.params.id, req.user!.id, req.user!.role);
    if (!source) {
      res.status(404).json({ error: 'Event not found' });
      return;
    }

    const sourceStart = parseDateSafe(String(source.start_date));
    const sourceEnd = parseDateSafe(String(source.end_date));
    if (!sourceStart || !sourceEnd) {
      res.status(400).json({ error: 'Source event has invalid dates' });
      return;
    }

    const durationMs = Math.max(30 * 60 * 1000, sourceEnd.getTime() - sourceStart.getTime());
    const requestedStart = parseDateSafe(req.body?.start_date);
    const shiftDays = Number(req.body?.shift_days);
    const start = requestedStart
      || (Number.isFinite(shiftDays)
        ? new Date(sourceStart.getTime() + (shiftDays * 24 * 60 * 60 * 1000))
        : new Date(sourceStart.getTime() + (7 * 24 * 60 * 60 * 1000)));
    const requestedEnd = parseDateSafe(req.body?.end_date);
    const end = requestedEnd || new Date(start.getTime() + durationMs);

    const newId = uuidv4();
    await pool.query(
      `INSERT INTO events (
        id, title, description, short_description, category_id, organizer_id,
        banner_url, venue_name, venue_address, city, state, country,
        start_date, end_date, registration_deadline, max_attendees, current_attendees,
        is_free, price, currency, status, event_started, event_started_at,
        is_private, is_online, online_link, tags, invite_template,
        is_recurring, recurrence_frequency, recurrence_interval, recurrence_end_type, recurrence_end_date, recurrence_count_limit, recurrence_generated_count, recurrence_parent_id, last_recurrence_generated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 'draft', FALSE, NULL, ?, ?, ?, ?, ?, FALSE, NULL, 1, 'never', NULL, NULL, 0, NULL, NULL)`,
      [
        newId, source.title, source.description || null, source.short_description || null, source.category_id || null, req.user!.id,
        source.banner_url || null, source.venue_name || null, source.venue_address || null, source.city || null, source.state || null, source.country || 'India',
        start, end, source.registration_deadline || null, source.max_attendees || null,
        source.is_free ?? true, source.price || 0, source.currency || 'INR',
        source.is_private ?? false, source.is_online ?? false, source.online_link || null, source.tags || null, normalizeInviteTemplate(source.invite_template),
      ]
    );

    const [rows] = await pool.query<Event[]>('SELECT * FROM events WHERE id = ?', [newId]);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to clone event' });
  }
};

export const updateRecurrence = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const event = await assertEventAccess(req.params.id, req.user!.id, req.user!.role);
    if (!event) {
      res.status(404).json({ error: 'Event not found' });
      return;
    }
    if (event.recurrence_parent_id) {
      res.status(400).json({ error: 'Recurrence can only be managed on base event' });
      return;
    }

    const action = String(req.body?.action || '').trim().toLowerCase();
    if (action === 'pause') {
      await pool.query('UPDATE events SET is_recurring = FALSE WHERE id = ?', [req.params.id]);
    } else if (action === 'resume') {
      await pool.query('UPDATE events SET is_recurring = TRUE WHERE id = ?', [req.params.id]);
    } else if (action === 'stop') {
      await pool.query(
        `UPDATE events
         SET is_recurring = FALSE,
             recurrence_end_type = 'after_count',
             recurrence_count_limit = recurrence_generated_count
         WHERE id = ?`,
        [req.params.id]
      );
    } else {
      const updates: string[] = [];
      const values: unknown[] = [];

      if (req.body.is_recurring !== undefined) {
        updates.push('is_recurring = ?');
        values.push(Boolean(req.body.is_recurring));
      }
      if (req.body.recurrence_frequency !== undefined) {
        const freq = String(req.body.recurrence_frequency) as RecurrenceFrequency;
        if (!['daily', 'weekly', 'monthly'].includes(freq)) {
          res.status(400).json({ error: 'Invalid recurrence_frequency' });
          return;
        }
        updates.push('recurrence_frequency = ?');
        values.push(freq);
      }
      if (req.body.recurrence_interval !== undefined) {
        updates.push('recurrence_interval = ?');
        values.push(Math.max(1, Number(req.body.recurrence_interval) || 1));
      }
      if (req.body.recurrence_end_type !== undefined) {
        const endType = String(req.body.recurrence_end_type) as RecurrenceEndType;
        if (!['never', 'on_date', 'after_count'].includes(endType)) {
          res.status(400).json({ error: 'Invalid recurrence_end_type' });
          return;
        }
        updates.push('recurrence_end_type = ?');
        values.push(endType);
      }
      if (req.body.recurrence_end_date !== undefined) {
        updates.push('recurrence_end_date = ?');
        values.push(req.body.recurrence_end_date || null);
      }
      if (req.body.recurrence_count_limit !== undefined) {
        updates.push('recurrence_count_limit = ?');
        values.push(req.body.recurrence_count_limit ? Math.max(1, Number(req.body.recurrence_count_limit)) : null);
      }

      if (!updates.length) {
        res.status(400).json({ error: 'No recurrence fields to update' });
        return;
      }

      values.push(req.params.id);
      await pool.query(`UPDATE events SET ${updates.join(', ')} WHERE id = ?`, values);
    }

    const [updated] = await pool.query<Event[]>('SELECT * FROM events WHERE id = ?', [req.params.id]);
    res.json(updated[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update recurrence' });
  }
};

export const processRecurringEvents = async (): Promise<void> => {
  try {
    const [series] = await pool.query<Event[]>(
      `SELECT *
       FROM events
       WHERE is_recurring = TRUE
         AND recurrence_parent_id IS NULL
         AND status = 'published'
         AND recurrence_frequency IS NOT NULL
         AND (recurrence_end_type <> 'on_date' OR recurrence_end_date IS NULL OR recurrence_end_date >= NOW())
         AND (recurrence_end_type <> 'after_count' OR recurrence_count_limit IS NULL OR recurrence_generated_count < recurrence_count_limit)
       ORDER BY updated_at DESC
       LIMIT 25`
    );

    for (const base of series) {
      const frequency = String(base.recurrence_frequency || '') as RecurrenceFrequency;
      if (!['daily', 'weekly', 'monthly'].includes(frequency)) continue;
      const interval = Math.max(1, Number(base.recurrence_interval) || 1);

      const [lastRows] = await pool.query<RowDataPacket[]>(
        `SELECT id, start_date, end_date
         FROM events
         WHERE id = ? OR recurrence_parent_id = ?
         ORDER BY start_date DESC
         LIMIT 1`,
        [base.id, base.id]
      );
      const latest = lastRows[0];
      if (!latest?.start_date || !latest?.end_date) continue;

      const latestStart = new Date(latest.start_date as string);
      const latestEnd = new Date(latest.end_date as string);
      const nextStart = addInterval(latestStart, frequency, interval);
      const nextEnd = new Date(nextStart.getTime() + Math.max(30 * 60 * 1000, latestEnd.getTime() - latestStart.getTime()));
      const oneDayAhead = Date.now() + (24 * 60 * 60 * 1000);
      if (nextStart.getTime() > oneDayAhead) continue;

      const endType = String(base.recurrence_end_type || 'never') as RecurrenceEndType;
      if (endType === 'on_date') {
        const endDate = parseDateSafe(String(base.recurrence_end_date || ''));
        if (endDate && nextStart.getTime() > endDate.getTime()) {
          await pool.query('UPDATE events SET is_recurring = FALSE WHERE id = ?', [base.id]);
          continue;
        }
      }

      const [exists] = await pool.query<RowDataPacket[]>(
        `SELECT id
         FROM events
         WHERE recurrence_parent_id = ?
           AND start_date = ?
         LIMIT 1`,
        [base.id, nextStart]
      );
      if (exists.length) continue;

      const id = uuidv4();
      await pool.query(
        `INSERT INTO events (
          id, title, description, short_description, category_id, organizer_id,
          banner_url, venue_name, venue_address, city, state, country,
          start_date, end_date, registration_deadline, max_attendees, current_attendees,
          is_free, price, currency, status, event_started, event_started_at,
          is_private, is_online, online_link, tags, invite_template,
          is_recurring, recurrence_frequency, recurrence_interval, recurrence_end_type, recurrence_end_date, recurrence_count_limit, recurrence_generated_count, recurrence_parent_id, last_recurrence_generated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 'published', FALSE, NULL, ?, ?, ?, ?, ?, FALSE, NULL, 1, 'never', NULL, NULL, 0, ?, NULL)`,
        [
          id, base.title, base.description || null, base.short_description || null, base.category_id || null, base.organizer_id,
          base.banner_url || null, base.venue_name || null, base.venue_address || null, base.city || null, base.state || null, base.country || 'India',
          nextStart, nextEnd, base.registration_deadline || null, base.max_attendees || null,
          base.is_free ?? true, base.price || 0, base.currency || 'INR',
          base.is_private ?? false, base.is_online ?? false, base.online_link || null, base.tags || null, normalizeInviteTemplate(base.invite_template),
          base.id,
        ]
      );

      await pool.query(
        `UPDATE events
         SET recurrence_generated_count = recurrence_generated_count + 1,
             last_recurrence_generated_at = NOW()
         WHERE id = ?`,
        [base.id]
      );
    }
  } catch (err) {
    console.error('Recurring scheduler failed', err);
  }
};

export const deleteEvent = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const [rows] = await pool.query<Event[]>('SELECT * FROM events WHERE id = ?', [req.params.id]);
    if (!rows[0]) {
      res.status(404).json({ error: 'Event not found' });
      return;
    }
    if (rows[0].organizer_id !== req.user!.id && req.user!.role !== 'admin') {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    await pool.query('DELETE FROM events WHERE id = ?', [req.params.id]);
    res.json({ message: 'Event deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete event' });
  }
};

export const getMyEvents = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const [rows] = await pool.query<Event[]>(
      `SELECT e.*, c.name AS category_name, c.icon AS category_icon
       FROM events e
       LEFT JOIN categories c ON e.category_id = c.id
       WHERE e.organizer_id = ?
       ORDER BY e.created_at DESC`,
      [req.user!.id]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch events' });
  }
};

export const likeEvent = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const [existing] = await pool.query<RowDataPacket[]>(
      'SELECT id FROM event_likes WHERE event_id = ? AND user_id = ?',
      [req.params.id, req.user!.id]
    );

    if (existing.length > 0) {
      await pool.query('DELETE FROM event_likes WHERE event_id = ? AND user_id = ?', [req.params.id, req.user!.id]);
      res.json({ liked: false });
    } else {
      await pool.query('INSERT INTO event_likes (event_id, user_id) VALUES (?, ?)', [req.params.id, req.user!.id]);
      res.json({ liked: true });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to toggle like' });
  }
};

export const getTrendingEvents = async (_req: Request, res: Response): Promise<void> => {
  try {
    const [rows] = await pool.query<Event[]>(
      `SELECT e.*, c.name AS category_name, c.slug AS category_slug, c.icon AS category_icon,
              u.name AS organizer_name
       FROM events e
       LEFT JOIN categories c ON e.category_id = c.id
       LEFT JOIN users u ON e.organizer_id = u.id
       WHERE e.status = 'published' AND e.start_date >= NOW() AND e.is_private = FALSE
       ORDER BY e.current_attendees DESC
       LIMIT 6`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch trending events' });
  }
};

export const getCategories = async (_req: Request, res: Response): Promise<void> => {
  try {
    const [rows] = await pool.query<RowDataPacket[]>('SELECT * FROM categories ORDER BY name');
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
};

export const changeEventStatus = async (req: AuthRequest, res: Response): Promise<void> => {
  const { id } = req.params;
  const { status } = req.body as { status: string };
  const allowed = ['draft', 'published', 'cancelled', 'completed'];
  if (!allowed.includes(status)) { res.status(400).json({ error: 'Invalid status' }); return; }
  try {
    const [[event]] = await pool.query<Event[]>('SELECT * FROM events WHERE id = ?', [id]);
    if (!event) { res.status(404).json({ error: 'Event not found' }); return; }
    if (event.organizer_id !== req.user!.id && req.user!.role !== 'admin') {
      res.status(403).json({ error: 'Forbidden' }); return;
    }
    await pool.query('UPDATE events SET status = ? WHERE id = ?', [status, id]);
    res.json({ message: 'Status updated', status });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update status' });
  }
};

export const startEvent = async (req: AuthRequest, res: Response): Promise<void> => {
  const { id } = req.params;
  try {
    const event = await assertEventAccess(id, req.user!.id, req.user!.role);
    if (!event) {
      res.status(404).json({ error: 'Event not found' });
      return;
    }
    if (event.status === 'cancelled' || event.status === 'completed') {
      res.status(400).json({ error: 'Cancelled or completed event cannot be started' });
      return;
    }
    await pool.query(
      `UPDATE events
       SET status = CASE WHEN status = 'draft' THEN 'published' ELSE status END,
           event_started = TRUE,
           event_started_at = NOW()
       WHERE id = ?`,
      [id]
    );
    res.json({ ok: true, event_started: true, message: 'Event started' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to start event' });
  }
};

export const stopEvent = async (req: AuthRequest, res: Response): Promise<void> => {
  const { id } = req.params;
  try {
    const event = await assertEventAccess(id, req.user!.id, req.user!.role);
    if (!event) {
      res.status(404).json({ error: 'Event not found' });
      return;
    }
    await pool.query(
      'UPDATE events SET event_started = FALSE WHERE id = ?',
      [id]
    );
    res.json({ ok: true, event_started: false, message: 'Event stopped' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to stop event' });
  }
};
