// Setting a host up before their first visit, and handing them a starter roster.
//
// The point of the feature is what a brand new host sees, so these tests do not stop at
// "the row was written": they go on to prove the two doors that host walks through actually
// open. GET /api/roster/:phone is what the management page's picker reads, and the
// verification request is what My Games, Roster and Stats put in front of them.
//
// DEV_ROSTER_SOURCE is pinned to 'local' before the app is required, for the same reason
// scripts/capture-screens.js pins it: the developer routes default to editing LIVE
// PRODUCTION when they run outside production, and a test must never reach inorout.club.
process.env.DEV_ROSTER_SOURCE = 'local';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../app');
const { config } = require('../config');
const { chooseDeveloperRosterSource } = require('../utils/dev-rosters');
const { createSessionToken } = require('../services/host-verification');

const DEV_HEADERS = { 'X-Dev-Password': config.devPassword };

// 555 numbers throughout, matching the convention the other fixtures use.
const EXISTING_HOST = '5557770001';
const BRETT = '5557770002';
const PLAYER_ONE = '5558880011';
const PLAYER_TWO = '5558880012';
const NOBODY = '5559990099';

let server;
let base;
let fixtureGame;

async function req(method, path, body, headers = {}) {
  const res = await fetch(base + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json', ...headers } : headers,
    body: body ? JSON.stringify(body) : undefined
  });
  let json = null;
  try {
    json = await res.json();
  } catch {}
  return { status: res.status, json };
}

const devReq = (method, path, body) =>
  // ?source=local as well as the environment pin: belt and braces on the one thing that
  // must never happen here.
  req(method, path + (path.includes('?') ? '&' : '?') + 'source=local', body, DEV_HEADERS);

async function hostRosterFor(phone) {
  const res = await req('GET', `/api/roster/${phone}`, null, {
    Authorization: `Bearer ${createSessionToken(phone)}`
  });
  return res;
}

before(async () => {
  const app = createApp({ production: false, textbeltSecret: 'starter-roster-test-key' });
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;

  // A host who arrived the ordinary way, with two players in the master directory.
  fixtureGame = (await req('POST', '/api/games', {
    location: 'Starter Roster Court',
    organizerName: 'Existing Host',
    organizerPhone: EXISTING_HOST,
    organizerPlaying: false,
    date: '2099-12-01',
    time: '13:00',
    duration: 90,
    totalPlayers: 8,
    message: '',
    registrationMode: 'fcfs'
  })).json;
  assert.ok(fixtureGame.gameId, 'fixture game was created');

  for (const [name, phone] of [['Player One', PLAYER_ONE], ['Player Two', PLAYER_TWO]]) {
    const joined = await req('POST', `/api/games/${fixtureGame.gameId}/players`, { name, phone });
    assert.equal(joined.status, 201, `${name} joined the fixture game`);
  }
});

after(async () => {
  await devReq('DELETE', `/api/dev/hosts/${BRETT}`, { confirmPhone: BRETT });
  await req('DELETE', `/api/games/${fixtureGame.gameId}`, {
    token: fixtureGame.hostToken,
    reason: 'starter roster test cleanup'
  });
  await req('DELETE', `/api/games/${fixtureGame.gameId}/permanent`, { token: fixtureGame.hostToken });
  await new Promise((resolve) => server.close(resolve));
});

describe('a host set up from the developer area', () => {
  it('never lets a local test run reach the production database', () => {
    assert.equal(
      chooseDeveloperRosterSource({
        production: false,
        configuredSource: process.env.DEV_ROSTER_SOURCE,
        requestedSource: 'production'
      }),
      'local'
    );
  });

  it('refuses every new route without the developer password', async () => {
    const calls = [
      await req('POST', '/api/dev/hosts', { name: 'Nope', phone: BRETT }),
      await req('POST', `/api/dev/hosts/${BRETT}/roster`, { phones: [PLAYER_ONE] }),
      await req('DELETE', `/api/dev/hosts/${BRETT}/roster/${PLAYER_ONE}`)
    ];
    for (const call of calls) assert.equal(call.status, 401);
  });

  it('rejects a name or number it cannot use', async () => {
    assert.equal((await devReq('POST', '/api/dev/hosts', { name: 'Brett', phone: '12345' })).status, 400);
    assert.equal((await devReq('POST', '/api/dev/hosts', { name: '  ', phone: BRETT })).status, 400);
  });

  it('appears in the directory before they have created a single game', async () => {
    const added = await devReq('POST', '/api/dev/hosts', { name: 'Brett Olson', phone: BRETT });
    assert.equal(added.status, 200);
    assert.deepEqual(added.json.host, { phone: BRETT, name: 'Brett Olson' });

    const directory = await devReq('GET', '/api/dev/rosters');
    const brett = directory.json.hosts.find((host) => host.phone === BRETT);
    assert.ok(brett, 'the new host is listed');
    assert.equal(brett.name, 'Brett Olson');
    assert.deepEqual(brett.players, [], 'and starts with nobody');
  });

  it('refuses a second host on the same number', async () => {
    const again = await devReq('POST', '/api/dev/hosts', { name: 'Brett Again', phone: BRETT });
    assert.equal(again.status, 409);
  });

  it('copies chosen players from other rosters onto the new host', async () => {
    const seeded = await devReq('POST', `/api/dev/hosts/${BRETT}/roster`, {
      phones: [PLAYER_ONE, `(555) 888-0012`]
    });
    assert.equal(seeded.status, 200);
    assert.equal(seeded.json.added, 2);
    assert.equal(seeded.json.alreadyOnRoster, 0);

    const directory = await devReq('GET', '/api/dev/rosters');
    const brett = directory.json.hosts.find((host) => host.phone === BRETT);
    assert.deepEqual(
      brett.players.map((player) => player.phone).sort(),
      [PLAYER_ONE, PLAYER_TWO]
    );
    assert.ok(brett.players.every((player) => player.saved), 'seeded rows are removable');
    // The player they were copied from keeps their own roster.
    const existing = directory.json.hosts.find((host) => host.phone === EXISTING_HOST);
    assert.equal(existing.players.length, 2);
  });

  // The whole point: what Brett sees the first time he opens the app.
  it('shows up as the roster his management page reads', async () => {
    const roster = await hostRosterFor(BRETT);
    assert.equal(roster.status, 200);
    assert.deepEqual(
      roster.json.roster.map((player) => player.phone).sort(),
      [PLAYER_ONE, PLAYER_TWO]
    );
    assert.deepEqual(
      roster.json.roster.map((player) => player.name).sort(),
      ['Player One', 'Player Two']
    );
  });

  it('lets him past the text-me-a-code gate before he has hosted anything', async () => {
    const requested = await req('POST', '/api/host-verification/request', { phone: BRETT });
    assert.equal(requested.status, 200, 'a seeded roster is enough to be recognized as a host');

    const stranger = await req('POST', '/api/host-verification/request', { phone: NOBODY });
    assert.equal(stranger.status, 404, 'and an unknown number still is not');
  });

  it('never overwrites a name the host has already saved', async () => {
    const renamed = await req('PUT', `/api/roster/${BRETT}/${PLAYER_ONE}`, { name: 'Big Al' }, {
      Authorization: `Bearer ${createSessionToken(BRETT)}`
    });
    assert.equal(renamed.status, 200);

    const again = await devReq('POST', `/api/dev/hosts/${BRETT}/roster`, {
      phones: [PLAYER_ONE, PLAYER_TWO]
    });
    assert.equal(again.json.added, 0);
    assert.equal(again.json.alreadyOnRoster, 2);

    const roster = await hostRosterFor(BRETT);
    const player = roster.json.roster.find((entry) => entry.phone === PLAYER_ONE);
    assert.equal(player.name, 'Big Al', 'the host-entered name survived the second seeding');
  });

  it('refuses numbers nobody in the app has ever played with', async () => {
    const unknown = await devReq('POST', `/api/dev/hosts/${BRETT}/roster`, { phones: [NOBODY] });
    assert.equal(unknown.status, 400);
    assert.match(unknown.json.error, /master roster/i);
  });

  it('refuses to put a host on their own roster', async () => {
    const self = await devReq('POST', `/api/dev/hosts/${BRETT}/roster`, { phones: [BRETT] });
    assert.equal(self.status, 400);
    assert.match(self.json.error, /own roster/i);
  });

  it('refuses an empty selection and an oversized one', async () => {
    assert.equal((await devReq('POST', `/api/dev/hosts/${BRETT}/roster`, { phones: [] })).status, 400);
    const tooMany = await devReq('POST', `/api/dev/hosts/${BRETT}/roster`, {
      phones: new Array(251).fill(PLAYER_ONE)
    });
    assert.equal(tooMany.status, 400);
  });

  it('takes one player back off again', async () => {
    const removed = await devReq('DELETE', `/api/dev/hosts/${BRETT}/roster/${PLAYER_TWO}`);
    assert.equal(removed.status, 200);

    const roster = await hostRosterFor(BRETT);
    assert.deepEqual(roster.json.roster.map((player) => player.phone), [PLAYER_ONE]);

    const twice = await devReq('DELETE', `/api/dev/hosts/${BRETT}/roster/${PLAYER_TWO}`);
    assert.equal(twice.status, 404, 'removing a row that is already gone says so');
  });

  it('leaves the players themselves alone when the seeded host is deleted', async () => {
    const deleted = await devReq('DELETE', `/api/dev/hosts/${BRETT}`, { confirmPhone: BRETT });
    assert.equal(deleted.status, 200);

    const directory = await devReq('GET', '/api/dev/rosters');
    assert.ok(!directory.json.hosts.some((host) => host.phone === BRETT), 'the host is gone');
    assert.ok(
      directory.json.players.some((player) => player.phone === PLAYER_ONE),
      'the player they were copied from is untouched'
    );
  });
});
