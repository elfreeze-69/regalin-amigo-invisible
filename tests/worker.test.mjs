import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/index.js';

class MockD1 {
  constructor(initialized = true) {
    this.sqlite = new DatabaseSync(':memory:');
    if (initialized) this.sqlite.exec(readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8'));
  }

  async exec(sql) {
    this.sqlite.exec(sql);
  }

  prepare(sql) {
    const db = this.sqlite;
    return {
      bind(...args) {
        const prep = () => db.prepare(sql);
        return {
          async first() { return prep().get(...args) || null; },
          async all() { return { results: prep().all(...args) }; },
          async run() {
            const result = prep().run(...args);
            return { meta: { changes: result.changes } };
          },
        };
      },
    };
  }

  async batch(statements) {
    this.sqlite.exec('BEGIN IMMEDIATE;');
    try {
      const result = [];
      for (const statement of statements) result.push(await statement.run());
      this.sqlite.exec('COMMIT;');
      return result;
    } catch (error) {
      this.sqlite.exec('ROLLBACK;');
      throw error;
    }
  }
}

async function setup() {
  const db = new MockD1();
  async function request(method, path, body, token) {
    const headers = new Headers();
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    if (token) headers.set('Authorization', `Bearer ${token}`);
    const response = await worker.fetch(new Request(`https://example.test/api${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }), { DB: db });
    return { status: response.status, data: await response.json() };
  }
  return { db, request };
}

async function create(request, name = 'Ana', title = 'Navidad') {
  const response = await request('POST', '/rooms', { title, name, budget: '20.50', giftDate: '2026-12-24' });
  assert.equal(response.status, 201);
  return response.data;
}

async function join(request, code, name) {
  const response = await request('POST', `/rooms/${code}/join`, { name });
  assert.equal(response.status, 201);
  return response.data;
}

test('crear sala y consultar información pública sin filtrar tokens', async () => {
  const { db, request } = await setup();
  const owner = await create(request, 'Jorge');
  const room = await request('GET', `/rooms/${owner.code}`);
  assert.equal(room.status, 200);
  assert.equal(room.data.room.title, 'Navidad');
  assert.equal(room.data.room.count, 1);
  assert.equal(room.data.room.budget, 20.5);
  assert.equal(room.data.room.gift_date, '2026-12-24');
  assert.deepEqual(room.data.room.members, [{ name: 'Jorge' }]);
  assert.equal(JSON.stringify(room.data).includes(owner.token), false);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM members WHERE token_hash=?').get(owner.token).n, 0);
});

test('sorteo secreto sin autoasignaciones ni destinatarios repetidos; acceso privado', async () => {
  const { request, db } = await setup();
  const host = await create(request, 'Jorge');
  const others = [];
  for (const name of ['María', 'Luis', 'Claudia', 'Rubén', 'Nuria']) {
    others.push({ name, ...(await join(request, host.code, name)) });
  }
  const participants = [{ name: 'Jorge', ...host }, ...others];

  const before = await request('GET', `/rooms/${host.code}/reveal`, undefined, host.token);
  assert.equal(before.status, 409);
  const guestDraw = await request('POST', `/rooms/${host.code}/draw`, {}, others[0].token);
  assert.equal(guestDraw.status, 403);
  const invalid = await request('GET', `/rooms/${host.code}/reveal`, undefined, 'a'.repeat(64));
  assert.equal(invalid.status, 401);

  const draw = await request('POST', `/rooms/${host.code}/draw`, {}, host.token);
  assert.equal(draw.status, 200);
  const room = await request('GET', `/rooms/${host.code}`);
  assert.equal(room.data.room.status, 'drawn');
  assert.equal(JSON.stringify(room.data).includes('receiver_id'), false);
  const assigned = [];
  for (const player of participants) {
    const result = await request('GET', `/rooms/${host.code}/reveal`, undefined, player.token);
    assert.equal(result.status, 200);
    assert.notEqual(result.data.recipient, player.name);
    assigned.push(result.data.recipient);
    const again = await request('GET', `/rooms/${host.code}/reveal`, undefined, player.token);
    assert.equal(again.data.recipient, result.data.recipient);
  }
  assert.equal(new Set(assigned).size, participants.length);
  assert.deepEqual(new Set(assigned), new Set(participants.map(p => p.name)));
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM assignments').get().n, participants.length);
  assert.equal((await request('POST', `/rooms/${host.code}/draw`, {}, host.token)).status, 409);
  assert.equal((await request('POST', `/rooms/${host.code}/join`, { name: 'Se une tarde' })).status, 409);
});

test('solo un nombre por sala y sorteo de 2 intercambia los destinatarios', async () => {
  const { request } = await setup();
  const host = await create(request, 'Sara');
  const duplicate = await request('POST', `/rooms/${host.code}/join`, { name: 'sARA' });
  assert.equal(duplicate.status, 409);
  const other = await join(request, host.code, 'Pepe');
  assert.equal((await request('POST', `/rooms/${host.code}/draw`, {}, host.token)).status, 200);
  assert.equal((await request('GET', `/rooms/${host.code}/reveal`, undefined, host.token)).data.recipient, 'Pepe');
  assert.equal((await request('GET', `/rooms/${host.code}/reveal`, undefined, other.token)).data.recipient, 'Sara');
});

test('no se puede sortear con una sola persona; el aforo máximo es 30', async () => {
  const { request } = await setup();
  const owner = await create(request);
  const single = await request('POST', `/rooms/${owner.code}/draw`, {}, owner.token);
  assert.equal(single.status, 409);
  assert.equal((await request('GET', `/rooms/${owner.code}`)).data.room.status, 'open');
  for (let i = 1; i < 30; i++) await join(request, owner.code, `Persona ${i}`);
  const extra = await request('POST', `/rooms/${owner.code}/join`, { name: 'Extra' });
  assert.equal(extra.status, 409);
  assert.equal((await request('GET', `/rooms/${owner.code}`)).data.room.count, 30);
});

test('rechaza datos mal formados y códigos inexistentes', async () => {
  const { request } = await setup();
  assert.equal((await request('POST', '/rooms', { title: 'x', name: 'A' })).status, 400);
  assert.equal((await request('POST', '/rooms', { title: 'Fiesta', name: 'Ana', budget: '-30' })).status, 400);
  assert.equal((await request('POST', '/rooms', { title: 'Fiesta', name: 'Ana', giftDate: '2026-02-31' })).status, 400);
  assert.equal((await request('GET', '/rooms/WRONG!')).status, 400);
  assert.equal((await request('GET', '/rooms/AAAAAA')).status, 404);
});

test('al publicar desde el móvil, la primera petición prepara automáticamente la base vacía', async () => {
  const db = new MockD1(false);
  const response = await worker.fetch(new Request('https://example.test/api/health'), { DB: db });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, 'ok');
  const tables = db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('rooms','members','assignments')").all();
  assert.equal(tables.length, 3);
});
