import { Request, Response } from 'express';
import db from '../utils/db';
import { v4 as uuidv4 } from 'uuid';

export async function getFeedback(req: Request, res: Response) {
  const { eventId } = req.params;
  const [rows] = await db.query<any[]>(
    `SELECT f.id, f.rating, f.comment, f.is_anonymous, f.created_at,
            IF(f.is_anonymous=1, 'Anonymous', u.name) as user_name,
            IF(f.is_anonymous=1, NULL, u.avatar) as user_avatar
     FROM event_feedback f LEFT JOIN users u ON u.id = f.user_id
     WHERE f.event_id = ? ORDER BY f.created_at DESC`,
    [eventId]
  );
  const [[stats]] = await db.query<any[]>(
    'SELECT AVG(rating) as avg_rating, COUNT(*) as total, SUM(rating=5) as five, SUM(rating=4) as four, SUM(rating=3) as three, SUM(rating=2) as two, SUM(rating=1) as one FROM event_feedback WHERE event_id = ?',
    [eventId]
  );
  res.json({ feedback: rows, stats });
}

export async function submitFeedback(req: Request, res: Response) {
  const { eventId } = req.params;
  const user = (req as any).user;
  const { rating, comment = '', is_anonymous = false } = req.body;
  if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: 'rating 1-5 required' });

  const [[event]] = await db.query<any[]>('SELECT id, end_date, status FROM events WHERE id = ?', [eventId]);
  if (!event) return res.status(404).json({ error: 'Event not found' });

  const [[existing]] = await db.query<any[]>('SELECT id FROM event_feedback WHERE event_id=? AND user_id=?', [eventId, user.id]);
  const id = uuidv4();
  if (existing) {
    await db.query('UPDATE event_feedback SET rating=?, comment=?, is_anonymous=? WHERE id=?', [rating, comment, is_anonymous ? 1 : 0, existing.id]);
  } else {
    await db.query('INSERT INTO event_feedback (id,event_id,user_id,rating,comment,is_anonymous) VALUES (?,?,?,?,?,?)',
      [id, eventId, user.id, rating, comment, is_anonymous ? 1 : 0]);
  }
  // Update denormalized avg
  await db.query('UPDATE events SET avg_rating=(SELECT AVG(rating) FROM event_feedback WHERE event_id=?), feedback_count=(SELECT COUNT(*) FROM event_feedback WHERE event_id=?) WHERE id=?',
    [eventId, eventId, eventId]);
  res.json({ success: true });
}

export async function deleteFeedback(req: Request, res: Response) {
  const { eventId, feedbackId } = req.params;
  const user = (req as any).user;
  const [[fb]] = await db.query<any[]>('SELECT user_id FROM event_feedback WHERE id=? AND event_id=?', [feedbackId, eventId]);
  if (!fb) return res.status(404).json({ error: 'Feedback not found' });
  if (fb.user_id !== user.id && user.role !== 'admin') return res.status(403).json({ error: 'Not authorized' });
  await db.query('DELETE FROM event_feedback WHERE id=?', [feedbackId]);
  await db.query('UPDATE events SET avg_rating=(SELECT COALESCE(AVG(rating),0) FROM event_feedback WHERE event_id=?), feedback_count=(SELECT COUNT(*) FROM event_feedback WHERE event_id=?) WHERE id=?',
    [eventId, eventId, eventId]);
  res.json({ success: true });
}
