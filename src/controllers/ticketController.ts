import { Request, Response } from 'express';
import db from '../utils/db';
import { v4 as uuidv4 } from 'uuid';

export async function getTicketTypes(req: Request, res: Response) {
  const { eventId } = req.params;
  const [rows] = await db.query('SELECT * FROM ticket_types WHERE event_id = ? ORDER BY sort_order, price', [eventId]);
  res.json(rows);
}

export async function createTicketType(req: Request, res: Response) {
  const { eventId } = req.params;
  const user = (req as any).user;
  const [[event]] = await db.query<any[]>('SELECT organizer_id FROM events WHERE id = ?', [eventId]);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  if (event.organizer_id !== user.id && user.role !== 'admin')
    return res.status(403).json({ error: 'Not authorized' });

  const { name, description = '', price = 0, capacity = null, is_free = false, sale_start = null, sale_end = null, sort_order = 0 } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });

  const id = uuidv4();
  await db.query(
    'INSERT INTO ticket_types (id,event_id,name,description,price,capacity,is_free,sale_start,sale_end,sort_order) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [id, eventId, name, description, is_free ? 0 : price, capacity, is_free ? 1 : 0, sale_start, sale_end, sort_order]
  );
  const [[tt]] = await db.query<any[]>('SELECT * FROM ticket_types WHERE id = ?', [id]);
  res.status(201).json(tt);
}

export async function updateTicketType(req: Request, res: Response) {
  const { eventId, ticketId } = req.params;
  const user = (req as any).user;
  const [[event]] = await db.query<any[]>('SELECT organizer_id FROM events WHERE id = ?', [eventId]);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  if (event.organizer_id !== user.id && user.role !== 'admin')
    return res.status(403).json({ error: 'Not authorized' });

  const { name, description, price, capacity, is_free, sale_start, sale_end, sort_order } = req.body;
  await db.query(
    'UPDATE ticket_types SET name=COALESCE(?,name), description=COALESCE(?,description), price=COALESCE(?,price), capacity=COALESCE(?,capacity), is_free=COALESCE(?,is_free), sale_start=COALESCE(?,sale_start), sale_end=COALESCE(?,sale_end), sort_order=COALESCE(?,sort_order) WHERE id=? AND event_id=?',
    [name, description, price, capacity, is_free !== undefined ? (is_free ? 1 : 0) : null, sale_start, sale_end, sort_order, ticketId, eventId]
  );
  const [[tt]] = await db.query<any[]>('SELECT * FROM ticket_types WHERE id = ?', [ticketId]);
  res.json(tt);
}

export async function deleteTicketType(req: Request, res: Response) {
  const { eventId, ticketId } = req.params;
  const user = (req as any).user;
  const [[event]] = await db.query<any[]>('SELECT organizer_id FROM events WHERE id = ?', [eventId]);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  if (event.organizer_id !== user.id && user.role !== 'admin')
    return res.status(403).json({ error: 'Not authorized' });
  await db.query('DELETE FROM ticket_types WHERE id = ? AND event_id = ?', [ticketId, eventId]);
  res.json({ success: true });
}
