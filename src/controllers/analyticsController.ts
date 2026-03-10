import { Response } from 'express';
import pool from '../utils/db';
import { RowDataPacket } from 'mysql2';
import { AuthRequest } from '../middleware/auth';
import { Request } from 'express';

// Track a view (called on event page load)
export const trackView = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  try {
    const today = new Date().toISOString().split('T')[0];
    await pool.query(
      `INSERT INTO event_views (event_id, viewed_at, count)
       VALUES (?, ?, 1)
       ON DUPLICATE KEY UPDATE count = count + 1`,
      [id, today]
    );
    await pool.query('UPDATE events SET views = views + 1 WHERE id = ?', [id]);
    res.json({ ok: true });
  } catch {
    res.json({ ok: false });
  }
};

// Full analytics for an event (organizer only)
export const getEventAnalytics = async (req: AuthRequest, res: Response): Promise<void> => {
  const { id } = req.params;
  try {
    const [[event]] = await pool.query<RowDataPacket[]>(
      'SELECT id, organizer_id, title, views, current_attendees, max_attendees, is_free, price, created_at FROM events WHERE id = ?',
      [id]
    );
    if (!event) { res.status(404).json({ error: 'Not found' }); return; }
    if (event.organizer_id !== req.user!.id && req.user!.role !== 'admin') {
      res.status(403).json({ error: 'Forbidden' }); return;
    }

    // Daily views last 14 days
    const [dailyViews] = await pool.query<RowDataPacket[]>(
      `SELECT viewed_at AS date, count AS views
       FROM event_views WHERE event_id = ?
       AND viewed_at >= DATE_SUB(CURDATE(), INTERVAL 14 DAY)
       ORDER BY viewed_at ASC`,
      [id]
    );

    // RSVP breakdown
    const [rsvpStats] = await pool.query<RowDataPacket[]>(
      `SELECT status, COUNT(*) AS count FROM rsvps WHERE event_id = ? GROUP BY status`,
      [id]
    );

    // Daily RSVPs last 14 days
    const [dailyRsvps] = await pool.query<RowDataPacket[]>(
      `SELECT DATE(created_at) AS date, COUNT(*) AS count
       FROM rsvps WHERE event_id = ?
       AND created_at >= DATE_SUB(NOW(), INTERVAL 14 DAY)
       GROUP BY DATE(created_at) ORDER BY date ASC`,
      [id]
    );

    // Check-in rate
    const [[checkinStats]] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS total, SUM(checked_in) AS checked_in FROM rsvps WHERE event_id = ? AND status = 'going'`,
      [id]
    );

    // Waitlist count
    const [[waitlist]] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS count FROM waitlist WHERE event_id = ?`,
      [id]
    ).catch(() => [[{ count: 0 }]] as [RowDataPacket[]]);

    // Campaign stats
    const [campaigns] = await pool.query<RowDataPacket[]>(
      `SELECT name, type, status, sent_count, total_recipients, created_at FROM campaigns WHERE event_id = ? ORDER BY created_at DESC LIMIT 10`,
      [id]
    );

    // Fill in missing dates for daily views
    const viewMap: Record<string, number> = {};
    (dailyViews as RowDataPacket[]).forEach((v) => { viewMap[v.date] = v.views; });
    const rsvpMap: Record<string, number> = {};
    (dailyRsvps as RowDataPacket[]).forEach((v) => { rsvpMap[v.date] = v.count; });

    const last14: { date: string; views: number; rsvps: number }[] = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split('T')[0];
      last14.push({ date: dateStr, views: viewMap[dateStr] || 0, rsvps: rsvpMap[dateStr] || 0 });
    }

    const rsvpBreakdown: Record<string, number> = { going: 0, maybe: 0, not_going: 0 };
    (rsvpStats as RowDataPacket[]).forEach((r) => { rsvpBreakdown[r.status] = r.count; });

    const checkin = checkinStats as RowDataPacket;
    const conversionRate = event.views > 0
      ? Math.round((rsvpBreakdown.going / event.views) * 100 * 10) / 10
      : 0;

    res.json({
      event: { id: event.id, title: event.title, views: event.views, created_at: event.created_at },
      overview: {
        total_views: event.views,
        total_rsvps: rsvpBreakdown.going + rsvpBreakdown.maybe + rsvpBreakdown.not_going,
        going: rsvpBreakdown.going,
        maybe: rsvpBreakdown.maybe,
        not_going: rsvpBreakdown.not_going,
        checked_in: Number(checkin.checked_in) || 0,
        capacity_used: event.max_attendees
          ? Math.round((event.current_attendees / event.max_attendees) * 100)
          : null,
        waitlist: Number((waitlist as RowDataPacket).count) || 0,
        conversion_rate: conversionRate,
      },
      daily: last14,
      campaigns,
    });
  } catch (err) {
    console.error('analytics error:', err);
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
};

// Organizer-level analytics (all events summary)
export const getOrganizerAnalytics = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const [[summary]] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS total_events,
              SUM(current_attendees) AS total_attendees,
              SUM(views) AS total_views,
              SUM(CASE WHEN status = 'published' THEN 1 ELSE 0 END) AS active_events
       FROM events WHERE organizer_id = ?`,
      [req.user!.id]
    );

    const [topEvents] = await pool.query<RowDataPacket[]>(
      `SELECT id, title, current_attendees, views, status, start_date
       FROM events WHERE organizer_id = ?
       ORDER BY current_attendees DESC LIMIT 5`,
      [req.user!.id]
    );

    const [recentRsvps] = await pool.query<RowDataPacket[]>(
      `SELECT DATE(r.created_at) AS date, COUNT(*) AS count
       FROM rsvps r JOIN events e ON e.id = r.event_id
       WHERE e.organizer_id = ? AND r.created_at >= DATE_SUB(NOW(), INTERVAL 14 DAY)
       GROUP BY DATE(r.created_at) ORDER BY date ASC`,
      [req.user!.id]
    );

    res.json({ summary, topEvents, recentRsvps });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
};
