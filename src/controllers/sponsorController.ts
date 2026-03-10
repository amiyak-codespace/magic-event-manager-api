import { Request, Response } from 'express';
import db from '../utils/db';
import { v4 as uuidv4 } from 'uuid';

export async function getSponsors(req: Request, res: Response) {
  const { eventId } = req.params;
  const [rows] = await db.query('SELECT * FROM event_sponsors WHERE event_id = ? ORDER BY FIELD(tier,"platinum","gold","silver","bronze","community"), sort_order', [eventId]);
  res.json(rows);
}

export async function createSponsor(req: Request, res: Response) {
  const { eventId } = req.params;
  const user = (req as any).user;
  const [[event]] = await db.query<any[]>('SELECT organizer_id FROM events WHERE id = ?', [eventId]);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  if (event.organizer_id !== user.id && user.role !== 'admin') return res.status(403).json({ error: 'Not authorized' });

  const { name, logo_url = '', website_url = '', tier = 'silver', description = '', sort_order = 0 } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const id = uuidv4();
  await db.query('INSERT INTO event_sponsors (id,event_id,name,logo_url,website_url,tier,description,sort_order) VALUES (?,?,?,?,?,?,?,?)',
    [id, eventId, name, logo_url, website_url, tier, description, sort_order]);
  const [[s]] = await db.query<any[]>('SELECT * FROM event_sponsors WHERE id=?', [id]);
  res.status(201).json(s);
}

export async function updateSponsor(req: Request, res: Response) {
  const { eventId, sponsorId } = req.params;
  const user = (req as any).user;
  const [[event]] = await db.query<any[]>('SELECT organizer_id FROM events WHERE id = ?', [eventId]);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  if (event.organizer_id !== user.id && user.role !== 'admin') return res.status(403).json({ error: 'Not authorized' });
  const { name, logo_url, website_url, tier, description, sort_order } = req.body;
  await db.query('UPDATE event_sponsors SET name=COALESCE(?,name), logo_url=COALESCE(?,logo_url), website_url=COALESCE(?,website_url), tier=COALESCE(?,tier), description=COALESCE(?,description), sort_order=COALESCE(?,sort_order) WHERE id=? AND event_id=?',
    [name, logo_url, website_url, tier, description, sort_order, sponsorId, eventId]);
  const [[s]] = await db.query<any[]>('SELECT * FROM event_sponsors WHERE id=?', [sponsorId]);
  res.json(s);
}

export async function deleteSponsor(req: Request, res: Response) {
  const { eventId, sponsorId } = req.params;
  const user = (req as any).user;
  const [[event]] = await db.query<any[]>('SELECT organizer_id FROM events WHERE id = ?', [eventId]);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  if (event.organizer_id !== user.id && user.role !== 'admin') return res.status(403).json({ error: 'Not authorized' });
  await db.query('DELETE FROM event_sponsors WHERE id=? AND event_id=?', [sponsorId, eventId]);
  res.json({ success: true });
}
