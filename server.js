import express from 'express';
import pg from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Подключение к PostgreSQL
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Настройки администратора
const OWNER_LOGIN = process.env.OWNER_LOGIN || 'brngzn03';
const OWNER_PASSWORD = process.env.OWNER_PASSWORD || 'change-this-password';
const OWNER_TOKEN = 'secret-restart-owner-token'; // Токен авторизации

app.use(express.json());
app.use(express.static(path.join(__dirname, 'dist')));

// Инициализация таблиц БД при запуске
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS rooms (
        id INT PRIMARY KEY,
        status VARCHAR(20) DEFAULT 'free',
        occupied_until BIGINT DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS news (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        text TEXT NOT NULL,
        date VARCHAR(50) NOT NULL
      );

      CREATE TABLE IF NOT EXISTS reservations (
        id SERIAL PRIMARY KEY,
        room_id INT NOT NULL,
        name VARCHAR(100) NOT NULL,
        phone VARCHAR(50) NOT NULL,
        time VARCHAR(50) NOT NULL,
        status VARCHAR(20) DEFAULT 'pending',
        client_token VARCHAR(100) NOT NULL
      );
    `);

    // Заполнение начальных VIP залов (4 зала)
    const { rowCount } = await pool.query('SELECT * FROM rooms');
    if (rowCount === 0) {
      for (let i = 1; i <= 4; i++) {
        await pool.query('INSERT INTO rooms (id, status) VALUES ($1, $2)', [i, 'free']);
      }
    }
  } catch (err) {
    console.error('Ошибка инициализации БД:', err);
  }
}

initDB();

// Middleware для проверки прав владельца
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader === `Bearer ${OWNER_TOKEN}`) {
    next();
  } else {
    res.status(401).json({ message: 'Неверный токен доступа' });
  }
}

// --- API ENDPOINTS ---

// Авторизация владельца
app.post('/api/auth/login', (req, res) => {
  const { login, password } = req.body;
  if (login === OWNER_LOGIN && password === OWNER_PASSWORD) {
    res.json({ token: OWNER_TOKEN });
  } else {
    res.status(401).json({ message: 'Неверный логин или пароль' });
  }
});

// Получить список VIP залов
app.get('/api/rooms', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, status, occupied_until AS "occupiedUntil" FROM rooms ORDER BY id ASC');
    const rooms = rows.map(r => ({
      ...r,
      occupiedUntil: Number(r.occupiedUntil)
    }));
    res.json(rooms);
  } catch (err) {
    res.status(500).json({ message: 'Ошибка загрузки залов' });
  }
});

// Получить новости
app.get('/api/news', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM news ORDER BY id DESC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: 'Ошибка загрузки новостей' });
  }
});

// Добавить новость (Только владелец)
app.post('/api/news', authMiddleware, async (req, res) => {
  const { title, text } = req.body;
  const date = new Date().toLocaleDateString('ru-RU');
  try {
    const { rows } = await pool.query(
      'INSERT INTO news (title, text, date) VALUES ($1, $2, $3) RETURNING *',
      [title, text, date]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ message: 'Ошибка публикации новости' });
  }
});

// Создать заявку на бронь
app.post('/api/reservations', async (req, res) => {
  const { roomId, name, phone, time } = req.body;
  const clientToken = Math.random().toString(36).substring(2) + Date.now().toString(36);

  try {
    const { rows } = await pool.query(
      'INSERT INTO reservations (room_id, name, phone, time, client_token) VALUES ($1, $2, $3, $4, $5) RETURNING id, client_token AS "clientToken"',
      [roomId, name, phone, time, clientToken]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ message: 'Ошибка создания брони' });
  }
});

// Проверить статус заявки (Для клиента)
app.get('/api/reservations/:id/status', async (req, res) => {
  const { id } = req.params;
  const { token } = req.query;

  try {
    const { rows } = await pool.query(
      'SELECT status FROM reservations WHERE id = $1 AND client_token = $2',
      [id, token]
    );
    if (rows.length === 0) {
      return res.status(404).json({ message: 'Заявка не найдена' });
    }
    res.json({ status: rows[0].status });
  } catch (err) {
    res.status(500).json({ message: 'Ошибка проверки статуса' });
  }
});

// Получить все заявки (Только владелец)
app.get('/api/reservations', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, room_id AS "roomId", name, phone, time, status FROM reservations ORDER BY id DESC'
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: 'Ошибка получения заявок' });
  }
});

// Изменить статус заявки (Подтвердить / Отклонить)
app.patch('/api/reservations/:id', authMiddleware, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  try {
    await pool.query('UPDATE reservations SET status = $1 WHERE id = $2', [status, id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: 'Ошибка обновления статуса' });
  }
});

// Раздача SPA фронтенда Vite (Client-side routing)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Сервер RESTART PS CLUB запущен на порту ${PORT}`);
});
