'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');

process.env.DB_PATH = path.join(os.tmpdir(), `reserve-test-${process.pid}-${Date.now()}.db`);
process.env.MANAGER_PASSCODE = 'manager123';
const { app, nowIST } = require('../server');

let server, base;
test.before(() => new Promise(resolve => {
  server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => { server.closeAllConnections?.(); server.close(); });

function daysAhead(n) {
  const d = new Date(nowIST().date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const DATE = daysAhead(3);

async function call(method, url, body, headers = {}) {
  const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, json };
}
async function guest(name, email) { return (await call('POST', '/api/guest', { name, email })).json; }

test('seed data: 4 restaurants with 8 tables each', async () => {
  const { json: list } = await call('GET', '/api/restaurants');
  assert.equal(list.length, 4);
  for (const r of list) {
    const f = await call('GET', `/api/restaurants/${r.id}/floor?date=${DATE}&time=19:00`);
    assert.equal(f.json.tables.length, 8);
  }
});

test('guest connect key is 24 characters and stable per email', async () => {
  const a = await guest('Asha', 'asha@example.com');
  const b = await guest('Asha R', 'ASHA@example.com');
  assert.equal(a.key.length, 24);
  assert.equal(a.key, b.key);
});

test('a booking lasts exactly 90 minutes', async () => {
  const g = await guest('Dur', 'dur@example.com');
  const r = await call('POST', '/api/bookings', { restaurant_id: 1, table_id: 1, date: DATE, time: '19:00', party_size: 2 }, { 'x-guest-key': g.key });
  assert.equal(r.status, 200);
  assert.equal(r.json.start, '19:00');
  assert.equal(r.json.end, '20:30');
});

test('overlapping bookings on the same table are rejected, adjacent ones are allowed', async () => {
  const g = await guest('Ov', 'ov@example.com');
  const h = { 'x-guest-key': g.key };
  const mk = time => call('POST', '/api/bookings', { restaurant_id: 2, table_id: 9, date: DATE, time, party_size: 2 }, h);
  assert.equal((await mk('19:00')).status, 200);
  assert.equal((await mk('19:30')).status, 409);  // starts inside the first booking
  assert.equal((await mk('18:00')).status, 409);  // ends inside the first booking
  assert.equal((await mk('20:30')).status, 200);  // starts exactly when the first ends
  assert.equal((await mk('17:30')).status, 200);  // ends exactly when the first starts
});

test('simultaneous requests cannot double-book a table', async () => {
  const gs = await Promise.all([1, 2, 3, 4, 5].map(i => guest('Race' + i, `race${i}@example.com`)));
  const results = await Promise.all(gs.map(g =>
    call('POST', '/api/bookings', { restaurant_id: 3, table_id: 17, date: DATE, time: '20:00', party_size: 2 }, { 'x-guest-key': g.key })));
  assert.equal(results.filter(r => r.status === 200).length, 1);
  assert.equal(results.filter(r => r.status === 409).length, 4);
});

test('booked tables show as booked, and cancelling frees them', async () => {
  const g = await guest('Can', 'can@example.com');
  const h = { 'x-guest-key': g.key };
  const b = await call('POST', '/api/bookings', { restaurant_id: 4, table_id: 25, date: DATE, time: '13:00', party_size: 2 }, h);
  const state = async () => (await call('GET', `/api/restaurants/4/floor?date=${DATE}&time=13:30`)).json.tables.find(t => t.id === 25).state;
  assert.equal(await state(), 'booked');
  const other = await guest('Other', 'other@example.com');
  assert.equal((await call('POST', `/api/bookings/${b.json.ref}/cancel`, null, { 'x-guest-key': other.key })).status, 403);
  assert.equal((await call('POST', `/api/bookings/${b.json.ref}/cancel`, null, h)).status, 200);
  assert.equal(await state(), 'vacant');
});

test('party size and past times are validated', async () => {
  const g = await guest('Val', 'val@example.com');
  const h = { 'x-guest-key': g.key };
  assert.equal((await call('POST', '/api/bookings', { restaurant_id: 1, table_id: 3, date: DATE, time: '19:00', party_size: 4 }, h)).status, 200);
  assert.equal((await call('POST', '/api/bookings', { restaurant_id: 1, table_id: 1, date: DATE, time: '21:00', party_size: 6 }, h)).status, 400); // 2-seater
  assert.equal((await call('POST', '/api/bookings', { restaurant_id: 1, date: '2020-01-01', time: '19:00', party_size: 2 }, h)).status, 400);
  assert.equal((await call('POST', '/api/bookings', { restaurant_id: 1, date: DATE, time: '23:00', party_size: 2 }, h)).status, 400);
});

test('manager actions need the passcode; block, free, add, resize, remove work', async () => {
  assert.equal((await call('POST', '/api/manager/login', { passcode: 'nope' })).status, 401);
  assert.equal((await call('POST', '/api/manager/tables/5/block', { date: DATE, time: '19:00' })).status, 401);
  const { json } = await call('POST', '/api/manager/login', { passcode: 'manager123' });
  const m = { 'x-manager-token': json.token };

  assert.equal((await call('POST', '/api/manager/tables/5/block', { date: DATE, time: '19:00' }, m)).status, 200);
  const g = await guest('Blk', 'blk@example.com');
  const blocked = await call('POST', '/api/bookings', { restaurant_id: 1, table_id: 5, date: DATE, time: '19:30', party_size: 2 }, { 'x-guest-key': g.key });
  assert.equal(blocked.status, 409);
  assert.equal((await call('POST', '/api/manager/tables/5/free', { date: DATE, time: '19:00' }, m)).status, 200);
  assert.equal((await call('POST', '/api/bookings', { restaurant_id: 1, table_id: 5, date: DATE, time: '19:30', party_size: 2 }, { 'x-guest-key': g.key })).status, 200);
  assert.equal((await call('POST', '/api/manager/tables/5/block', { date: DATE, time: '19:30' }, m)).status, 409); // already booked

  assert.equal((await call('POST', '/api/manager/restaurants/1/tables', { label: 'Patio 1', seats: 4 }, m)).status, 200);
  const floor = (await call('GET', `/api/manager/restaurants/1/floor?date=${DATE}&time=19:00`, null, m)).json;
  assert.equal(floor.tables.length, 9);
  const patio = floor.tables.find(t => t.label === 'Patio 1');
  assert.equal((await call('PATCH', `/api/manager/tables/${patio.id}`, { label: 'Patio A', seats: 6 }, m)).status, 200);
  assert.equal((await call('DELETE', `/api/manager/tables/${patio.id}`, null, m)).status, 200);
  const after = (await call('GET', `/api/restaurants/1/floor?date=${DATE}&time=19:00`)).json;
  assert.equal(after.tables.length, 8);
});

test('MCP: initialize, list tools, search, check, book, list, cancel', async () => {
  const g = await guest('Claude User', 'mcp@example.com');
  const url = `/mcp?key=${g.key}`;
  const rpc = (id, method, params) => call('POST', url, { jsonrpc: '2.0', id, method, params });

  assert.equal((await call('POST', '/mcp?key=wrong', { jsonrpc: '2.0', id: 1, method: 'initialize' })).status, 401);
  const init = await rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(init.json.result.serverInfo.name, 'reserve');
  assert.equal((await call('POST', url, { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);

  const tools = (await rpc(2, 'tools/list')).json.result.tools.map(t => t.name);
  assert.deepEqual(tools, ['search_restaurants', 'check_availability', 'book_table', 'list_my_bookings', 'cancel_booking']);

  const tool = async (name, args) => {
    const r = (await rpc(9, 'tools/call', { name, arguments: args })).json.result;
    return { isError: !!r.isError, data: r.isError ? r.content[0].text : JSON.parse(r.content[0].text) };
  };
  const search = await tool('search_restaurants', { area: 'Indiranagar', min_rating: 4.5 });
  assert.equal(search.data.restaurants[0].name, 'Kopper & Cane');

  const date = daysAhead(4);
  const avail = await tool('check_availability', { restaurant_id: 1, date, time: '20:00', party_size: 4 });
  assert.ok(avail.data.vacant_tables.length > 0);

  const booked = await tool('book_table', { restaurant_id: 1, date, time: '20:00', party_size: 4, table_id: avail.data.vacant_tables[0].table_id });
  assert.equal(booked.data.booked, true);
  assert.equal(booked.data.source, 'claude');
  assert.match(booked.data.confirmation_url, /\/confirmation\?ref=[A-Z0-9]{6}$/);

  const again = await tool('book_table', { restaurant_id: 1, date, time: '20:00', party_size: 4, table_id: avail.data.vacant_tables[0].table_id });
  assert.equal(again.isError, true);

  const mine = await tool('list_my_bookings', {});
  assert.equal(mine.data.count, 1);
  const cancelled = await tool('cancel_booking', { booking_ref: booked.data.ref });
  assert.equal(cancelled.data.cancelled, true);
  assert.equal((await tool('list_my_bookings', {})).data.count, 0);
});
