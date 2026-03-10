import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import pool from '../utils/db';
import { RowDataPacket } from 'mysql2';
import { AuthRequest } from '../middleware/auth';

export const createInvitation = async (req: AuthRequest, res: Response): Promise<void> => {
  const { event_id, template, custom_message } = req.body;
  try {
    const [events] = await pool.query<RowDataPacket[]>(
      'SELECT id, organizer_id FROM events WHERE id = ?',
      [event_id]
    );

    if (!events[0]) {
      res.status(404).json({ error: 'Event not found' });
      return;
    }

    if (events[0].organizer_id !== req.user!.id) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    const id = uuidv4();
    const shareToken = uuidv4().replace(/-/g, '').substring(0, 20);

    await pool.query(
      'INSERT INTO digital_invitations (id, event_id, template, custom_message, share_token) VALUES (?, ?, ?, ?, ?)',
      [id, event_id, template || 'default', custom_message || '', shareToken]
    );

    res.status(201).json({
      id,
      share_url: `${process.env.FRONTEND_URL}/invite/${shareToken}`,
      share_token: shareToken,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create invitation' });
  }
};

export const getInvitation = async (req: Request, res: Response): Promise<void> => {
  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT di.*, e.title, e.description, e.start_date, e.end_date,
              e.venue_name, e.city, e.banner_url, e.is_free, e.price, e.currency,
              e.is_online, e.current_attendees, e.max_attendees,
              u.name AS organizer_name
       FROM digital_invitations di
       JOIN events e ON di.event_id = e.id
       JOIN users u ON e.organizer_id = u.id
       WHERE di.share_token = ?`,
      [req.params.token]
    );

    if (!rows[0]) {
      res.status(404).json({ error: 'Invitation not found' });
      return;
    }

    await pool.query(
      'UPDATE digital_invitations SET view_count = view_count + 1 WHERE share_token = ?',
      [req.params.token]
    );

    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch invitation' });
  }
};
