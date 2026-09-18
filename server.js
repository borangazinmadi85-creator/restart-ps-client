import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

const app = express();
const port = process.env.PORT || 10000;
const ownerLogin = process.env.OWNER_LOGIN || 'brngzn03';
const ownerPassword = process.env.OWNER_PASSWORD || 'Cocolimbo03';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use(express.json());

const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }) : null;

const rooms = [1, 2, 3, 4].map((number) => ({
  id: number, name: `VIP ${String(number).padStart(2, '0')}`,
  status: number === 2 ? 'busy' : 'free', occupiedUntil: number === 2 ? Date.now() + 46 * 60 * 1000 : null,
  guest: number === 2 ? 'Алексей' : null
}));
let news = [];
const ownerSessions = new Set();

async function initDatabase() {
  if (!pool) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS reservations (
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT,
    room_id INTEGER NOT NULL CHECK (room_id BETWEEN 1 AND 4),
    reservation_time TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    client_token TEXT UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query('ALTER TABLE reservations ADD COLUMN IF NOT EXISTS client_token TEXT UNIQUE');
  await pool.query('ALTER TABLE reservations ALTER COLUMN phone DROP NOT NULL');
}

function reservationFromRow(row) {
  return { id: Number(row.id), name: row.name, roomId: row.room_id, time: row.reservation_time, status: row.status, clientToken: row.client_token, createdAt: row.created_at };
}

function isOwner(req) {
  return ownerSessions.has((req.headers.authorization || '').replace('Bearer ', ''));
}

app.post('/api/auth/login', (req, res) => {
  const { login, password } = req.body || {};
  if (login === ownerLogin && password === ownerPassword) {
    const token = crypto.randomUUID();
    ownerSessions.add(token);
    return res.json({ ok: true, token });
  }
  return res.status(401).json({ ok: false, message: 'Неверный логин или пароль' });
});
app.get('/api/rooms', (_req, res) => res.json(rooms));
app.get('/api/news', (_req, res) => res.json(news));
app.get('/api/reservations', async (req, res) => {
  if (!isOwner(req)) return res.status(401).json({ message: 'Доступ запрещён' });
  if (!pool) return res.status(503).json({ message: 'DATABASE_URL не настроен' });
  const result = await pool.query('SELECT * FROM reservations ORDER BY created_at DESC');
  res.json(result.rows.map(reservationFromRow));
});
app.get('/api/reservations/:id/status', async (req, res) => {
  if (!pool) return res.status(503).json({ message: 'База данных пока не подключена' });
  const result = await pool.query('SELECT id, room_id, reservation_time, status FROM reservations WHERE id = $1 AND client_token = $2', [req.params.id, req.query.token]);
  if (!result.rows[0]) return res.status(404).json({ message: 'Заявка не найдена' });
  res.json({ id: Number(result.rows[0].id), roomId: result.rows[0].room_id, time: result.rows[0].reservation_time, status: result.rows[0].status });
});
app.post('/api/reservations', async (req, res) => {
  const { name, phone, roomId, time } = req.body || {};
  const normalizedPhone = String(phone || '').replace(/\D/g, '');
  if (!name || !phone || !roomId || !time) return res.status(400).json({ message: 'Заполните имя, телефон, зал и время' });
  if (normalizedPhone.length !== 11 || !normalizedPhone.startsWith('7')) return res.status(400).json({ message: 'Введите номер в формате +7 (___) ___ __ __' });
  if (!pool) return res.status(503).json({ message: 'База данных пока не подключена' });
  const clientToken = crypto.randomUUID();
  const result = await pool.query('INSERT INTO reservations (name, phone, room_id, reservation_time, client_token) VALUES ($1, $2, $3, $4, $5) RETURNING *', [name.trim(), `+${normalizedPhone}`, Number(roomId), time, clientToken]);
  res.status(201).json(reservationFromRow(result.rows[0]));
});
app.patch('/api/reservations/:id', async (req, res) => {
  if (!isOwner(req)) return res.status(401).json({ message: 'Доступ запрещён' });
  if (!pool) return res.status(503).json({ message: 'DATABASE_URL не настроен' });
  const result = await pool.query('SELECT * FROM reservations WHERE id = $1', [req.params.id]);
  if (!result.rows[0]) return res.status(404).json({ message: 'Бронь не найдена' });
  const reservation = reservationFromRow(result.rows[0]);
  reservation.status = req.body.status === 'approved' ? 'approved' : 'rejected';
  if (reservation.status === 'approved') {
    const room = rooms.find((item) => item.id === reservation.roomId);
    if (room) { room.status = 'busy'; room.guest = reservation.name; room.occupiedUntil = Date.now() + 60 * 60 * 1000; }
  }
  const updated = await pool.query('UPDATE reservations SET status = $1 WHERE id = $2 RETURNING *', [reservation.status, reservation.id]);
  res.json(reservationFromRow(updated.rows[0]));
});
app.post('/api/news', (req, res) => {
  if (!isOwner(req)) return res.status(401).json({ message: 'Доступ запрещён' });
  const { title, text } = req.body || {};
  if (!title || !text) return res.status(400).json({ message: 'Заполните заголовок и текст' });
  const item = { id: Date.now(), title, text, date: new Date().toLocaleDateString('ru-RU') };
  news.unshift(item); res.status(201).json(item);
});
app.use(express.static(path.join(__dirname, 'dist')));
app.use((_req, res) => res.sendFile(path.join(__dirname, 'dist', 'index.html')));
initDatabase().then(() => app.listen(port, () => console.log(`RESTART server listening on ${port}`))).catch((error) => {
  console.error('PostgreSQL initialization failed:', error.message);
  process.exit(1);
});