/**
 * One persistence suite, run against both database engines.
 *
 * The unit suite is SQLite and production is PostgreSQL, so anything the two engines
 * disagree about - JSON storage, boolean shapes, transactions, constraint enforcement, the
 * compare-and-swap that guards game writes - is only really tested when the same
 * expectations run on both. These cases are the shared half:
 *
 *   test/persistence-parity.test.js      SQLite, inside `npm test`
 *   test-pg/persistence-parity.test.js   PostgreSQL, only via `npm run test:pg`
 *
 * `npm test` deliberately does not depend on the PostgreSQL half - it needs a disposable
 * database that a laptop or a CI box may not have.
 *
 * This file is not named *.test.js on purpose: the test glob would otherwise pick it up and
 * run the cases with no engine chosen.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const PREFIX = 'parity-';

// Reserved 555 numbers for the host-and-roster cases, kept away from the game fixtures.
const SEEDED_HOST = '5557779001';
const SEEDED_PLAYER_ONE = '5557779002';
const SEEDED_PLAYER_TWO = '5557779003';

function newGame(extra = {}) {
  return {
    gameName: 'Parity Test',
    date: '2026-09-02',
    time: '19:30',
    location: 'Char Bar',
    totalPlayers: 4,
    players: [],
    waitlist: [],
    hostToken: 'tok-parity',
    hostPhone: null,
    ...extra
  };
}

const player = (name) => ({ id: `p-${name}`, name, phone: null });
const names = (game) => (game.players || []).map((entry) => entry.name).sort();

function createBarrier(count) {
  let arrived = 0;
  let open;
  const gate = new Promise((resolve) => { open = resolve; });
  return () => {
    arrived += 1;
    if (arrived >= count) open();
    return gate;
  };
}

/**
 * Registers the shared cases.
 * @param {string} engine - 'SQLite' or 'PostgreSQL', used in the suite name only.
 */
function registerPersistenceCases(engine) {
  const { initializeDatabase } = require('../../database/schema');
  const {
    saveGame,
    getGame,
    updateGame,
    getAllGames,
    getGamesByHostPhone,
    getGameHostInfo,
    deleteGamePermanently
  } = require('../../database/games');
  const { savePhoto, getPhotosForGame } = require('../../database/locations-media');
  const { markReminderSent, hasReminderBeenSent } = require('../../database/messaging-reminders');
  const { upsertHost, listHosts, getHost, deleteHost } = require('../../database/hosts');
  const { upsertRosterEntry, getRosterForHost, deleteRosterEntry } = require('../../database/roster');
  const { addPlayersToHostRoster } = require('../../database/dev-rosters');

  const created = new Set();
  async function makeGame(name, extra) {
    const id = `${PREFIX}${engine.toLowerCase()}-${name}`;
    created.add(id);
    await deleteGamePermanently(id);
    const game = newGame(extra);
    await saveGame(id, game, game.hostToken, game.hostPhone);
    return id;
  }

  describe(`persistence on ${engine}`, () => {
    before(async () => {
      // The full boot path: migrations, reference seeds, message seeds. On PostgreSQL this
      // is the first thing that proves the migrations actually run on the real engine.
      await initializeDatabase();
    });

    after(async () => {
      for (const id of created) {
        await deleteGamePermanently(id);
      }
      await deleteHost(SEEDED_HOST);
      for (const phone of [SEEDED_PLAYER_ONE, SEEDED_PLAYER_TWO]) {
        await deleteRosterEntry(SEEDED_HOST, phone);
      }
    });

    describe('game data round-trips unchanged', () => {
      it('keeps nested structures, unicode, quotes and empty collections', async () => {
        const rich = {
          players: [
            { id: 'p1', name: "Scott O'Hara", phone: '+15551230000', dupr: 3.75, isAndroid: true },
            { id: 'p2', name: 'Renée 🎾', phone: null, isAndroid: false }
          ],
          waitlist: [],
          outPlayers: [{ id: 'p3', name: 'Bo', reason: 'Line 1\nLine 2 "quoted"' }],
          invitedPlayers: [{ phone: '+15551230001', name: '', sends: [{ ok: true, at: null }] }],
          hostNotes: 'Bring the good net — 100% sure this time',
          cancelled: false,
          totalPlayers: 4,
          registrationMode: 'open'
        };
        const id = await makeGame('round-trip', rich);

        const stored = await getGame(id);
        for (const key of Object.keys(rich)) {
          assert.deepEqual(stored[key], rich[key], `${key} did not survive the round trip`);
        }
        assert.equal(stored.hostToken, 'tok-parity');
      });

      it('reads the same game through the list queries', async () => {
        const id = await makeGame('lists', { hostPhone: '+15559990000', players: [player('Ada')] });
        await saveGame(id, { ...newGame({ players: [player('Ada')] }), hostPhone: '+15559990000' },
          'tok-parity', '+15559990000');

        const all = await getAllGames();
        assert.ok(all[id], 'getAllGames must include the game');
        assert.deepEqual(names(all[id]), ['Ada']);

        const byHost = await getGamesByHostPhone('+15559990000');
        const mine = byHost.find((game) => game.gameId === id);
        assert.ok(mine, 'getGamesByHostPhone must find the game');
        assert.equal(mine.hostToken, 'tok-parity');

        const hostInfo = await getGameHostInfo(id);
        assert.deepEqual(hostInfo, { phone: '+15559990000', hostToken: 'tok-parity' });
      });
    });

    describe('optimistic concurrency', () => {
      it('starts at version 1 and increments on every save', async () => {
        const id = await makeGame('version');
        const first = await getGame(id);
        assert.equal(first.version, 1);

        first.players.push(player('Ada'));
        await saveGame(id, first, first.hostToken, first.hostPhone);
        assert.equal((await getGame(id)).version, 2);
      });

      it('refuses a write made from a copy that is out of date', async () => {
        const id = await makeGame('stale');
        const readerA = await getGame(id);
        const readerB = await getGame(id);

        readerA.players.push(player('Ada'));
        await saveGame(id, readerA, readerA.hostToken, readerA.hostPhone);

        readerB.players.push(player('Bo'));
        await assert.rejects(
          () => saveGame(id, readerB, readerB.hostToken, readerB.hostPhone),
          (err) => err.code === 'GAME_VERSION_CONFLICT'
        );

        assert.deepEqual(names(await getGame(id)), ['Ada']);
      });

      it('keeps both roster changes when two updates overlap', async () => {
        const id = await makeGame('race');
        const bothHaveRead = createBarrier(2);

        const join = (name) =>
          updateGame(id, async (game, attempt) => {
            game.players.push(player(name));
            if (attempt === 1) await bothHaveRead();
            return { save: true, result: attempt };
          });

        const attempts = await Promise.all([join('Cleo'), join('Dev')]);

        assert.deepEqual(names(await getGame(id)), ['Cleo', 'Dev']);
        assert.deepEqual(attempts.sort(), [1, 2], 'exactly one of them had to retry');
      });

      it('never stores the version inside the game data', async () => {
        const id = await makeGame('blob');
        const game = await getGame(id);
        game.players.push(player('Fern'));
        await saveGame(id, game, game.hostToken, game.hostPhone);

        const all = await getAllGames();
        assert.equal(all[id].version, undefined);
      });
    });

    describe('transactions and constraints', () => {
      it('deletes a game with its photos in one go', async () => {
        const id = await makeGame('delete');
        const photo = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        await savePhoto(`${id}-photo`, id, 'image/png', photo, 'A shot', 'Scott');

        const before = await getPhotosForGame(id);
        assert.equal(before.length, 1);
        assert.equal(before[0].mimeType, 'image/png');
        assert.equal(before[0].bytes, photo.length, 'binary length must survive BYTEA/BLOB');

        const removed = await deleteGamePermanently(id);
        assert.equal(removed, 1);
        assert.equal(await getGame(id), null);
        assert.equal((await getPhotosForGame(id)).length, 0, 'photos go with the game');
      });

      it('records a reminder once, however many times it is written', async () => {
        const id = await makeGame('reminder');
        const phone = '+15558880000';

        assert.equal(await hasReminderBeenSent(id, phone, '24h'), false);
        await markReminderSent(id, phone, '24h');
        await markReminderSent(id, phone, '24h');
        assert.equal(await hasReminderBeenSent(id, phone, '24h'), true);
        assert.equal(await hasReminderBeenSent(id, phone, '2h'), false);
      });
    });

    // A host set up in the developer area, and the starter roster they are given. Both write
    // through ON CONFLICT clauses whose "did this actually insert?" answer is read from
    // rowCount on PostgreSQL and changes on SQLite - two different properties of two
    // different driver objects, which is exactly the kind of thing only parity catches.
    describe('a host and their starter roster', () => {
      it('creates a host, and a second write keeps the existing name', async () => {
        await deleteHost(SEEDED_HOST);
        await upsertHost(SEEDED_HOST, 'Brett Olson');
        assert.equal((await getHost(SEEDED_HOST)).name, 'Brett Olson');

        // A later write with no name must not blank the one already stored.
        await upsertHost(SEEDED_HOST, '');
        assert.equal((await getHost(SEEDED_HOST)).name, 'Brett Olson');

        await upsertHost(SEEDED_HOST, 'Brett O.');
        assert.equal((await getHost(SEEDED_HOST)).name, 'Brett O.');
        assert.ok((await listHosts()).some((host) => host.phone === SEEDED_HOST));
      });

      it('adds each player once and reports who was already there', async () => {
        for (const phone of [SEEDED_PLAYER_ONE, SEEDED_PLAYER_TWO]) {
          await deleteRosterEntry(SEEDED_HOST, phone);
        }

        const first = await addPlayersToHostRoster(SEEDED_HOST, [
          { phone: SEEDED_PLAYER_ONE, name: 'Player One', duprId: 'DUPR-1', duprRating: 4.25 },
          { phone: SEEDED_PLAYER_TWO, name: 'Player Two', duprId: '', duprRating: null }
        ]);
        assert.deepEqual(first.added.sort(), [SEEDED_PLAYER_ONE, SEEDED_PLAYER_TWO].sort());
        assert.deepEqual(first.skipped, []);

        const stored = await getRosterForHost(SEEDED_HOST);
        const one = stored.find((entry) => entry.playerPhone === SEEDED_PLAYER_ONE);
        assert.equal(one.name, 'Player One');
        assert.equal(one.duprId, 'DUPR-1');
        assert.equal(one.duprRating, 4.25, 'REAL and NUMERIC both come back as a number');

        // The host renames somebody, then the same seeding runs again.
        await upsertRosterEntry(SEEDED_HOST, SEEDED_PLAYER_ONE, 'Big Al', 'DUPR-1', 4.25);
        const second = await addPlayersToHostRoster(SEEDED_HOST, [
          { phone: SEEDED_PLAYER_ONE, name: 'Player One', duprId: '', duprRating: null },
          { phone: SEEDED_PLAYER_TWO, name: 'Player Two', duprId: '', duprRating: null }
        ]);
        assert.deepEqual(second.added, [], 'nobody is added twice');
        assert.deepEqual(
          second.skipped.sort(),
          [SEEDED_PLAYER_ONE, SEEDED_PLAYER_TWO].sort()
        );

        const after = await getRosterForHost(SEEDED_HOST);
        assert.equal(
          after.find((entry) => entry.playerPhone === SEEDED_PLAYER_ONE).name,
          'Big Al',
          'a name the host saved survives a second seeding'
        );
        assert.equal(after.length, 2);
      });
    });
  });
}

module.exports = { registerPersistenceCases };
