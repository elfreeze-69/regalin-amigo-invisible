/**
 * Regalín — sorteo secreto de amigo invisible con Cloudflare Workers + D1.
 * Los tokens privados nunca se guardan en claro en la base de datos.
 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_CODE_LENGTH = 6;
const MAX_MEMBERS = 30;

// La primera visita inicializa las tablas automáticamente, también al desplegar desde un móvil.
const INITIAL_SCHEMA = [
  String.raw`CREATE TABLE IF NOT EXISTS rooms (
  code TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  budget REAL,
  gift_date TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'drawn')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  drawn_at TEXT
);`,

  String.raw`CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  room_code TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  is_host INTEGER NOT NULL DEFAULT 0 CHECK (is_host IN (0, 1)),
  joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(room_code, name_key)
);`,

  String.raw`CREATE INDEX IF NOT EXISTS idx_members_room ON members(room_code, joined_at, id);`,

  String.raw`CREATE TABLE IF NOT EXISTS assignments (
  room_code TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
  giver_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  receiver_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  PRIMARY KEY(room_code, giver_id),
  CHECK (giver_id <> receiver_id)
);`,

  String.raw`CREATE TRIGGER IF NOT EXISTS block_late_members
BEFORE INSERT ON members
WHEN (SELECT status FROM rooms WHERE code = NEW.room_code) <> 'open'
BEGIN
  SELECT RAISE(ABORT, 'ROOM_CLOSED');
END;`,
];
const readyDatabases = new WeakSet();
async function ensureSchema(db) {
  if (readyDatabases.has(db)) return;
  const exists = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'rooms'").bind().first();
  if (!exists) await db.batch(INITIAL_SCHEMA.map(sql => db.prepare(sql).bind()));
  readyDatabases.add(db);
}


class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
    },
  });
}

function cleanText(value, min, max, label) {
  if (typeof value !== 'string') throw new HttpError(400, `${label}: escribe un texto válido.`);
  const cleaned = value.normalize('NFC').trim().replace(/\s+/g, ' ');
  const length = Array.from(cleaned).length;
  if (length < min || length > max) {
    throw new HttpError(400, `${label}: debe tener entre ${min} y ${max} caracteres.`);
  }
  return cleaned;
}

function nameKey(name) {
  return name.normalize('NFKC').toLocaleLowerCase('es').trim();
}

function parseBudget(value) {
  if (value === null || value === undefined || value === '') return null;
  const stringValue = String(value).trim().replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(stringValue)) throw new HttpError(400, 'Introduce un presupuesto válido en euros.');
  const amount = Number(stringValue);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 10000) {
    throw new HttpError(400, 'El presupuesto debe estar entre 0,01 € y 10.000 €.');
  }
  return amount;
}

function parseGiftDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new HttpError(400, 'Introduce una fecha válida.');
  }
  const date = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new HttpError(400, 'La fecha no es válida.');
  }
  return value;
}

async function parseBody(request) {
  const length = Number(request.headers.get('content-length') || 0);
  if (length > 4096) throw new HttpError(413, 'La solicitud es demasiado grande.');
  try {
    const text = await request.text();
    if (text.length > 4096) throw new HttpError(413, 'La solicitud es demasiado grande.');
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Not object');
    return value;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'No se ha podido leer el formulario.');
  }
}

function randomHex(bytes = 32) {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return Array.from(buffer, x => x.toString(16).padStart(2, '0')).join('');
}

function randomCode() {
  // 32 símbolos: evita el sesgo al convertir bytes aleatorios a índices.
  const bytes = new Uint8Array(ROOM_CODE_LENGTH);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, x => ALPHABET[x & 31]).join('');
}

async function tokenHash(token) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), x => x.toString(16).padStart(2, '0')).join('');
}

function validCode(value) {
  const code = String(value || '').trim().toUpperCase();
  if (!new RegExp(`^[${ALPHABET}]{${ROOM_CODE_LENGTH}}$`).test(code)) {
    throw new HttpError(400, 'El código de la sala no es válido.');
  }
  return code;
}

function isConstraintError(error) {
  return /UNIQUE constraint failed|SQLITE_CONSTRAINT|constraint failed/i.test(String(error?.message || ''));
}

async function getRoom(db, code) {
  return db.prepare('SELECT code, title, budget, gift_date, status, created_at FROM rooms WHERE code = ?')
    .bind(code).first();
}

async function getParticipants(db, code) {
  const result = await db.prepare('SELECT name FROM members WHERE room_code = ? ORDER BY joined_at, id')
    .bind(code).all();
  return result.results.map(member => ({ name: member.name }));
}

async function requireMember(request, db, code) {
  const auth = request.headers.get('authorization') || '';
  const match = /^Bearer ([a-f0-9]{64})$/i.exec(auth);
  if (!match) throw new HttpError(401, 'No tienes acceso a esta sala desde este navegador.');
  const hash = await tokenHash(match[1]);
  const member = await db.prepare(
    'SELECT id, name, is_host FROM members WHERE room_code = ? AND token_hash = ?'
  ).bind(code, hash).first();
  if (!member) throw new HttpError(401, 'No hemos encontrado tu participación en esta sala.');
  return member;
}

async function createRoom(request, db) {
  const body = await parseBody(request);
  const title = cleanText(body.title, 3, 70, 'Nombre de la sala');
  const name = cleanText(body.name, 2, 32, 'Tu nombre');
  const budget = parseBudget(body.budget);
  const giftDate = parseGiftDate(body.giftDate);
  const token = randomHex();
  const hash = await tokenHash(token);
  const memberId = crypto.randomUUID();

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomCode();
    try {
      await db.batch([
        db.prepare('INSERT INTO rooms (code, title, budget, gift_date) VALUES (?, ?, ?, ?)')
          .bind(code, title, budget, giftDate),
        db.prepare('INSERT INTO members (id, room_code, name, name_key, token_hash, is_host) VALUES (?, ?, ?, ?, ?, 1)')
          .bind(memberId, code, name, nameKey(name), hash),
      ]);
      return json({ code, token, isHost: true }, 201);
    } catch (error) {
      if (isConstraintError(error) && attempt < 4) continue;
      throw error;
    }
  }
  throw new HttpError(503, 'No hemos podido crear la sala. Inténtalo de nuevo.');
}

async function joinRoom(request, db, code) {
  const body = await parseBody(request);
  const name = cleanText(body.name, 2, 32, 'Tu nombre');
  const room = await getRoom(db, code);
  if (!room) throw new HttpError(404, 'No existe una sala con ese código.');
  if (room.status !== 'open') throw new HttpError(409, 'El sorteo ya está hecho. No se pueden añadir participantes.');

  const token = randomHex();
  const hash = await tokenHash(token);
  try {
    // El estado y el aforo se validan de nuevo dentro de la escritura.
    const result = await db.prepare(`
      INSERT INTO members (id, room_code, name, name_key, token_hash, is_host)
      SELECT ?, ?, ?, ?, ?, 0
      WHERE EXISTS (SELECT 1 FROM rooms WHERE code = ? AND status = 'open')
        AND (SELECT COUNT(*) FROM members WHERE room_code = ?) < ?
    `).bind(crypto.randomUUID(), code, name, nameKey(name), hash, code, code, MAX_MEMBERS).run();
    if (result.meta.changes !== 1) {
      throw new HttpError(409, 'La sala está cerrada o ha alcanzado el máximo de 30 personas.');
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (isConstraintError(error)) throw new HttpError(409, 'Ese nombre ya está en la sala. Añade un apellido o apodo.');
    if (/ROOM_CLOSED/.test(String(error?.message || ''))) {
      throw new HttpError(409, 'El sorteo ya está hecho. No se pueden añadir participantes.');
    }
    throw error;
  }
  return json({ code, token, isHost: false }, 201);
}

async function roomInfo(db, code) {
  const room = await getRoom(db, code);
  if (!room) throw new HttpError(404, 'No existe una sala con ese código.');
  const members = await getParticipants(db, code);
  return json({ room: { ...room, members, count: members.length, maxMembers: MAX_MEMBERS } });
}

async function myInfo(request, db, code) {
  const member = await requireMember(request, db, code);
  return json({ me: { name: member.name, isHost: member.is_host === 1 } });
}

async function draw(request, db, code) {
  const member = await requireMember(request, db, code);
  if (member.is_host !== 1) throw new HttpError(403, 'Solo quien ha creado la sala puede hacer el sorteo.');
  const room = await getRoom(db, code);
  if (!room) throw new HttpError(404, 'No existe esa sala.');
  if (room.status === 'drawn') throw new HttpError(409, 'El sorteo ya se ha realizado.');

  // Ambas sentencias se ejecutan en la MISMA transacción D1. Después de cambiar
  // el estado ya no pueden inscribirse personas, y el SELECT ve a todas las que
  // estaban apuntadas en el instante del sorteo.
  // Se barajan las posiciones y se asigna a la siguiente persona en un ciclo:
  // nadie puede tocarse a sí mismo y cada uno recibe exactamente un regalo.
  try {
    const results = await db.batch([
      db.prepare(`
        UPDATE rooms SET status = 'drawn', drawn_at = CURRENT_TIMESTAMP
        WHERE code = ? AND status = 'open'
        AND (SELECT COUNT(*) FROM members WHERE room_code = ?) >= 2
      `).bind(code, code),
      db.prepare(`
        WITH shuffled AS MATERIALIZED (
          SELECT id, ROW_NUMBER() OVER (ORDER BY RANDOM()) AS pos
          FROM members WHERE room_code = ?
        ), totals AS (
          SELECT COUNT(*) AS n FROM shuffled
        )
        INSERT INTO assignments (room_code, giver_id, receiver_id)
        SELECT ?, giver.id, receiver.id
        FROM shuffled giver CROSS JOIN totals
        JOIN shuffled receiver
          ON receiver.pos = CASE WHEN giver.pos = totals.n THEN 1 ELSE giver.pos + 1 END
        WHERE EXISTS (SELECT 1 FROM rooms WHERE code = ? AND status = 'drawn')
      `).bind(code, code, code),
    ]);
    if (results[0].meta.changes !== 1) {
      throw new HttpError(409, 'Necesitáis al menos 2 participantes o el sorteo ya está cerrado.');
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (isConstraintError(error)) throw new HttpError(409, 'El sorteo ya estaba hecho. Actualiza la sala.');
    throw error;
  }
  return json({ success: true });
}

async function reveal(request, db, code) {
  const member = await requireMember(request, db, code);
  const assignment = await db.prepare(`
    SELECT recipient.name AS recipient_name
    FROM assignments assignment
    JOIN members recipient ON recipient.id = assignment.receiver_id
    WHERE assignment.room_code = ? AND assignment.giver_id = ?
  `).bind(code, member.id).first();
  if (!assignment) throw new HttpError(409, 'Aún no se ha realizado el sorteo.');
  return json({ recipient: assignment.recipient_name });
}

async function handleApi(request, env, path) {
  if (!env.DB) throw new Error('Falta la base de datos D1. Revisa wrangler.jsonc.');
  await ensureSchema(env.DB);
  if (path === '/api/health' && request.method === 'GET') return json({ status: 'ok' });
  if (path === '/api/rooms' && request.method === 'POST') return createRoom(request, env.DB);
  const match = /^\/api\/rooms\/([^/]+)(?:\/(join|me|draw|reveal))?$/.exec(path);
  if (!match) throw new HttpError(404, 'Esta dirección no existe.');
  const code = validCode(match[1]);
  const action = match[2] || 'info';
  if (action === 'info' && request.method === 'GET') return roomInfo(env.DB, code);
  if (action === 'join' && request.method === 'POST') return joinRoom(request, env.DB, code);
  if (action === 'me' && request.method === 'GET') return myInfo(request, env.DB, code);
  if (action === 'draw' && request.method === 'POST') return draw(request, env.DB, code);
  if (action === 'reveal' && request.method === 'GET') return reveal(request, env.DB, code);
  throw new HttpError(405, 'Operación no permitida.');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      return await handleApi(request, env, url.pathname);
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      console.error('API error:', error?.message || error);
      return json({ error: 'Ha ocurrido un error. Vuelve a intentarlo.' }, 500);
    }
  },
};
