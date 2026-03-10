import { Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import pool from '../utils/db';
import { RowDataPacket } from 'mysql2';
import { AuthRequest } from '../middleware/auth';

export const getComments = async (req: AuthRequest, res: Response): Promise<void> => {
  const { id: eventId } = req.params;
  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT c.id, c.content, c.parent_id, c.is_pinned, c.created_at,
              u.id AS user_id, u.name AS user_name, u.avatar AS user_avatar, u.role AS user_role
       FROM comments c
       JOIN users u ON c.user_id = u.id
       WHERE c.event_id = ? AND c.is_deleted = FALSE
       ORDER BY c.is_pinned DESC, c.created_at ASC`,
      [eventId]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch comments' });
  }
};

export const addComment = async (req: AuthRequest, res: Response): Promise<void> => {
  const { id: eventId } = req.params;
  const { content, parent_id } = req.body as { content: string; parent_id?: string };
  if (!content?.trim()) { res.status(400).json({ error: 'Content required' }); return; }
  try {
    const id = uuidv4();
    await pool.query(
      'INSERT INTO comments (id, event_id, user_id, parent_id, content) VALUES (?, ?, ?, ?, ?)',
      [id, eventId, req.user!.id, parent_id || null, content.trim()]
    );
    const [[comment]] = await pool.query<RowDataPacket[]>(
      `SELECT c.id, c.content, c.parent_id, c.is_pinned, c.created_at,
              u.id AS user_id, u.name AS user_name, u.avatar AS user_avatar, u.role AS user_role
       FROM comments c JOIN users u ON c.user_id = u.id WHERE c.id = ?`,
      [id]
    );
    res.status(201).json(comment);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to add comment' });
  }
};

export const deleteComment = async (req: AuthRequest, res: Response): Promise<void> => {
  const { commentId } = req.params;
  try {
    const [[comment]] = await pool.query<RowDataPacket[]>(
      'SELECT user_id FROM comments WHERE id = ?', [commentId]
    );
    if (!comment) { res.status(404).json({ error: 'Comment not found' }); return; }
    if (comment.user_id !== req.user!.id && req.user!.role !== 'admin') {
      res.status(403).json({ error: 'Forbidden' }); return;
    }
    await pool.query('UPDATE comments SET is_deleted = TRUE WHERE id = ?', [commentId]);
    res.json({ message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete comment' });
  }
};

export const pinComment = async (req: AuthRequest, res: Response): Promise<void> => {
  const { commentId } = req.params;
  try {
    const [[event]] = await pool.query<RowDataPacket[]>(
      'SELECT e.organizer_id FROM comments c JOIN events e ON c.event_id = e.id WHERE c.id = ?',
      [commentId]
    );
    if (!event || (event.organizer_id !== req.user!.id && req.user!.role !== 'admin')) {
      res.status(403).json({ error: 'Forbidden' }); return;
    }
    await pool.query('UPDATE comments SET is_pinned = !is_pinned WHERE id = ?', [commentId]);
    res.json({ message: 'Toggled pin' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to pin comment' });
  }
};
