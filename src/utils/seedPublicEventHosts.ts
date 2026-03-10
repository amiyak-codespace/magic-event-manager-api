import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { RowDataPacket } from 'mysql2';
import pool from './db';

type EventRow = RowDataPacket & {
  id: string;
  title: string;
  organizer_id: string;
  organizer_name: string;
};

type UserRow = RowDataPacket & {
  id: string;
  name: string;
  email: string;
};

const DUMMY_HOSTS = [
  { name: 'Riya Sharma', email: 'riya.host@eventmagic.demo' },
  { name: 'Arjun Mehta', email: 'arjun.host@eventmagic.demo' },
  { name: 'Neha Reddy', email: 'neha.host@eventmagic.demo' },
  { name: 'Vikram Singh', email: 'vikram.host@eventmagic.demo' },
  { name: 'Priya Nair', email: 'priya.host@eventmagic.demo' },
];

async function findOrCreateOrganizer(name: string, email: string): Promise<UserRow> {
  const [rows] = await pool.query<UserRow[]>(
    'SELECT id, name, email FROM users WHERE lower(email) = lower(?) LIMIT 1',
    [email]
  );
  if (rows[0]) return rows[0];

  const id = uuidv4();
  const password = await bcrypt.hash('TempPass@123', 10);
  await pool.query(
    `INSERT INTO users (id, name, email, password, role, status, terms_accepted, privacy_accepted, consented_at, consent_version)
     VALUES (?, ?, ?, ?, 'organizer', 'active', TRUE, TRUE, NOW(), '2026-03')`,
    [id, name, email, password]
  );

  return { id, name, email } as UserRow;
}

async function run() {
  const connection = await pool.getConnection();
  try {
    const [eventRows] = await connection.query<EventRow[]>(
      `SELECT e.id, e.title, e.organizer_id, u.name AS organizer_name
       FROM events e
       JOIN users u ON u.id = e.organizer_id
       WHERE e.status = 'published' AND e.is_private = FALSE
       ORDER BY e.start_date ASC
       LIMIT 12`
    );

    if (!eventRows.length) {
      console.log('No public published events found to remap.');
      return;
    }

    const amiyaEvent = eventRows.find((e) => /amiya/i.test(e.organizer_name));
    const amiyaHostId = amiyaEvent?.organizer_id || eventRows[0].organizer_id;

    const dummyHostUsers: UserRow[] = [];
    for (const host of DUMMY_HOSTS) {
      dummyHostUsers.push(await findOrCreateOrganizer(host.name, host.email));
    }

    const hostPool = [amiyaHostId, ...dummyHostUsers.map((u) => u.id)];
    let updated = 0;

    for (let i = 0; i < eventRows.length; i += 1) {
      const event = eventRows[i];
      const targetHost = hostPool[i % hostPool.length];
      if (event.organizer_id === targetHost) continue;
      await connection.query('UPDATE events SET organizer_id = ? WHERE id = ?', [targetHost, event.id]);
      updated += 1;
    }

    console.log(`Processed events: ${eventRows.length}`);
    console.log(`Dummy organizers ready: ${dummyHostUsers.length}`);
    console.log(`Events reassigned: ${updated}`);
  } finally {
    connection.release();
  }
}

run()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('Failed to seed dummy hosts for public events:', err);
    await pool.end();
    process.exit(1);
  });
