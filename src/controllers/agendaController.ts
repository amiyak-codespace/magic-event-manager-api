import { Request, Response } from 'express';
import db from '../utils/db';
import { v4 as uuidv4 } from 'uuid';

export async function getAgenda(req: Request, res: Response) {
  const { eventId } = req.params;
  const [rows] = await db.query('SELECT * FROM agenda_items WHERE event_id = ? ORDER BY start_time, sort_order', [eventId]);
  res.json(rows);
}

export async function createAgendaItem(req: Request, res: Response) {
  const { eventId } = req.params;
  const user = (req as any).user;
  const [[event]] = await db.query<any[]>('SELECT organizer_id FROM events WHERE id = ?', [eventId]);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  if (event.organizer_id !== user.id && user.role !== 'admin')
    return res.status(403).json({ error: 'Not authorized' });

  const { title, description = '', speaker_name = '', speaker_title = '', speaker_avatar = '', start_time, end_time = null, location = '', type = 'talk', sort_order = 0 } = req.body;
  if (!title || !start_time) return res.status(400).json({ error: 'title and start_time required' });

  const id = uuidv4();
  await db.query(
    'INSERT INTO agenda_items (id,event_id,title,description,speaker_name,speaker_title,speaker_avatar,start_time,end_time,location,type,sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    [id, eventId, title, description, speaker_name, speaker_title, speaker_avatar, start_time, end_time, location, type, sort_order]
  );
  const [[item]] = await db.query<any[]>('SELECT * FROM agenda_items WHERE id = ?', [id]);
  res.status(201).json(item);
}

export async function updateAgendaItem(req: Request, res: Response) {
  const { eventId, itemId } = req.params;
  const user = (req as any).user;
  const [[event]] = await db.query<any[]>('SELECT organizer_id FROM events WHERE id = ?', [eventId]);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  if (event.organizer_id !== user.id && user.role !== 'admin')
    return res.status(403).json({ error: 'Not authorized' });

  const { title, description, speaker_name, speaker_title, speaker_avatar, start_time, end_time, location, type, sort_order } = req.body;
  await db.query(
    `UPDATE agenda_items SET
      title=COALESCE(?,title), description=COALESCE(?,description),
      speaker_name=COALESCE(?,speaker_name), speaker_title=COALESCE(?,speaker_title),
      speaker_avatar=COALESCE(?,speaker_avatar), start_time=COALESCE(?,start_time),
      end_time=COALESCE(?,end_time), location=COALESCE(?,location),
      type=COALESCE(?,type), sort_order=COALESCE(?,sort_order)
    WHERE id=? AND event_id=?`,
    [title, description, speaker_name, speaker_title, speaker_avatar, start_time, end_time, location, type, sort_order, itemId, eventId]
  );
  const [[item]] = await db.query<any[]>('SELECT * FROM agenda_items WHERE id = ?', [itemId]);
  res.json(item);
}

export async function deleteAgendaItem(req: Request, res: Response) {
  const { eventId, itemId } = req.params;
  const user = (req as any).user;
  const [[event]] = await db.query<any[]>('SELECT organizer_id FROM events WHERE id = ?', [eventId]);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  if (event.organizer_id !== user.id && user.role !== 'admin')
    return res.status(403).json({ error: 'Not authorized' });
  await db.query('DELETE FROM agenda_items WHERE id = ? AND event_id = ?', [itemId, eventId]);
  res.json({ success: true });
}
