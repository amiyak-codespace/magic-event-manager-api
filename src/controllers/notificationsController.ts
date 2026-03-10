import { Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import pool from '../utils/db';
import { RowDataPacket } from 'mysql2';
import { AuthRequest } from '../middleware/auth';

const EVENT_REMINDER_VISIBLE_WINDOW_MINUTES = Number(process.env.EVENT_REMINDER_VISIBLE_WINDOW_MINUTES || 45);
const EVENT_REMINDER_RETENTION_HOURS = Number(process.env.EVENT_REMINDER_RETENTION_HOURS || 6);
const NOTIFICATIONS_RETENTION_DAYS = Number(process.env.NOTIFICATIONS_RETENTION_DAYS || 45);

export const cleanupNotifications = async (): Promise<void> => {
  try {
    await pool.query(
      `DELETE n
       FROM notifications n
       LEFT JOIN events e
         ON e.id = JSON_UNQUOTE(JSON_EXTRACT(n.data, '$.event_id'))
       WHERE (
         n.type = 'event_reminder'
         AND e.id IS NOT NULL
         AND e.start_date < DATE_SUB(NOW(), INTERVAL ? HOUR)
       )
       OR n.created_at < DATE_SUB(NOW(), INTERVAL ? DAY)`,
      [EVENT_REMINDER_RETENTION_HOURS, NOTIFICATIONS_RETENTION_DAYS]
    );
  } catch (err) {
    console.error('Failed to cleanup notifications:', err);
  }
};

export const getNotifications = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT n.*
       FROM notifications n
       LEFT JOIN events e
         ON e.id = JSON_UNQUOTE(JSON_EXTRACT(n.data, '$.event_id'))
       WHERE n.user_id = ?
         AND (
           n.type <> 'event_reminder'
           OR e.id IS NULL
           OR e.start_date >= DATE_SUB(NOW(), INTERVAL ? MINUTE)
         )
       ORDER BY n.created_at DESC
       LIMIT 50`,
      [req.user!.id, EVENT_REMINDER_VISIBLE_WINDOW_MINUTES]
    );
    const [[{ unread }]] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS unread
       FROM notifications n
       LEFT JOIN events e
         ON e.id = JSON_UNQUOTE(JSON_EXTRACT(n.data, '$.event_id'))
       WHERE n.user_id = ?
         AND n.is_read = FALSE
         AND (
           n.type <> 'event_reminder'
           OR e.id IS NULL
           OR e.start_date >= DATE_SUB(NOW(), INTERVAL ? MINUTE)
         )`,
      [req.user!.id, EVENT_REMINDER_VISIBLE_WINDOW_MINUTES]
    );
    res.json({ notifications: rows, unread: Number(unread) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
};

export const markRead = async (req: AuthRequest, res: Response): Promise<void> => {
  const { id } = req.params;
  try {
    if (id === 'all') {
      await pool.query('UPDATE notifications SET is_read = TRUE WHERE user_id = ?', [req.user!.id]);
    } else {
      await pool.query('UPDATE notifications SET is_read = TRUE WHERE id = ? AND user_id = ?', [id, req.user!.id]);
    }
    res.json({ message: 'Marked as read' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to mark read' });
  }
};

export const createNotification = async (
  userId: string, type: string, title: string, message: string, data?: Record<string, unknown>
) => {
  try {
    await pool.query(
      'INSERT INTO notifications (id, user_id, type, title, message, data) VALUES (?, ?, ?, ?, ?, ?)',
      [uuidv4(), userId, type, title, message, data ? JSON.stringify(data) : null]
    );
  } catch (err) {
    console.error('Failed to create notification:', err);
  }
};
