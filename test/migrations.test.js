// Migrations run against throwaway SQLite files, never the app's own database, so these
// tests can assert on the real DDL without depending on what any developer's pickleball.db
// happens to contain.
//
// The case that matters most for production is "legacy database": production has had these
// tables since long before migrations existed, so the first migration has to find its work
// already done, change nothing, and simply record itself.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3');

const {
  createSqliteRunner,
  runMigrations,
  MIGRATIONS_TABLE
} = require('../database/migration-runner');
const migrations = require('../database/migrations');

let workspace;

before(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'inorout-migrations-'));
});

after(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

let counter = 0;
function openDatabase(name) {
  counter += 1;
  const file = path.join(workspace, `${name}-${counter}.db`);
  const db = new sqlite3.Database(file);
  return { db, file, runner: createSqliteRunner(db), close: () => new Promise((r) => db.close(r)) };
}

function tableNames(runner) {
  return runner
    .all("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .then((rows) => rows.map((row) => row.name));
}

describe('migrations on a fresh database', () => {
  it('creates every table and records each migration once', async () => {
    const { runner, close } = openDatabase('fresh');
    try {
      const first = await runMigrations(runner, migrations);
      assert.deepEqual(first.applied, migrations.map((migration) => migration.id));
      assert.deepEqual(first.alreadyApplied, []);

      const names = await tableNames(runner);
      for (const expected of [
        'games', 'sms_contexts', 'reminder_log', 'locations', 'host_roster', 'game_photos',
        'court_images', 'dev_notes', 'app_errors', 'sms_events', 'dev_assets',
        'message_personalities', 'personality_surface_settings', 'message_codex_prompts',
        'message_target_rules', 'randomizer_messages', 'message_selection_events', 'hosts',
        MIGRATIONS_TABLE
      ]) {
        assert.ok(names.includes(expected), `missing table ${expected}`);
      }

      // The columns that only ever arrived through a conditional ALTER.
      assert.ok(await runner.hasColumn('games', 'court_image_id'));
      assert.ok(await runner.hasColumn('locations', 'image_mime_type'));
      assert.ok(await runner.hasColumn('locations', 'image_data'));
      assert.ok(await runner.hasColumn('game_photos', 'uploader_name'));
      assert.ok(await runner.hasColumn('court_images', 'uploader_name'));
      assert.ok(await runner.hasColumn('games', 'version'));

      const recorded = await runner.all(`SELECT id FROM ${MIGRATIONS_TABLE} ORDER BY id`);
      assert.deepEqual(recorded.map((row) => row.id), migrations.map((m) => m.id));
    } finally {
      await close();
    }
  });

  it('is a no-op the second and third time it runs', async () => {
    const { runner, close } = openDatabase('repeat');
    try {
      await runMigrations(runner, migrations);
      const second = await runMigrations(runner, migrations);
      const third = await runMigrations(runner, migrations);

      assert.deepEqual(second.applied, []);
      assert.deepEqual(second.alreadyApplied, migrations.map((m) => m.id));
      assert.deepEqual(third.applied, []);

      const rows = await runner.all(`SELECT id FROM ${MIGRATIONS_TABLE}`);
      assert.equal(rows.length, migrations.length, 'no duplicate schema_migrations rows');
    } finally {
      await close();
    }
  });
});

describe('migrations on a database that predates them', () => {
  // The 2026-08-20 production shape, minus everything the conditional ALTERs added, plus
  // real rows. This is the rehearsal for the first production run.
  async function buildLegacyDatabase(runner) {
    await runner.exec([
      `CREATE TABLE games (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        host_token TEXT NOT NULL,
        host_phone TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE locations (
        name_key TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE game_photos (
        id TEXT PRIMARY KEY,
        game_id TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        data BLOB NOT NULL,
        caption TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE court_images (
        id TEXT PRIMARY KEY,
        court_name_key TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        image_data BLOB NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`
    ]);
    await runner.run(
      'INSERT INTO games (id, data, host_token, host_phone) VALUES (?, ?, ?, ?)',
      ['legacy-game', JSON.stringify({ players: [{ name: 'Scott' }] }), 'tok-legacy', '+15551230000']
    );
    await runner.run('INSERT INTO locations (name_key, display_name) VALUES (?, ?)', [
      'char bar',
      'Char Bar'
    ]);
  }

  it('adds what is missing, keeps the rows, and records the full history', async () => {
    const { runner, close } = openDatabase('legacy');
    try {
      await buildLegacyDatabase(runner);

      const result = await runMigrations(runner, migrations);
      assert.deepEqual(result.applied, migrations.map((m) => m.id));

      const game = await runner.get('SELECT * FROM games WHERE id = ?', ['legacy-game']);
      assert.equal(game.host_token, 'tok-legacy');
      assert.equal(game.host_phone, '+15551230000');
      assert.deepEqual(JSON.parse(game.data), { players: [{ name: 'Scott' }] });
      // Rows that existed before the column did start at version 0, which is a version
      // number like any other - the first save compares against it and moves to 1.
      assert.equal(game.version, 0);
      assert.equal(game.court_image_id, null);

      const location = await runner.get('SELECT * FROM locations WHERE name_key = ?', ['char bar']);
      assert.equal(location.display_name, 'Char Bar');
      assert.equal(location.image_mime_type, null);

      assert.ok(await runner.hasColumn('game_photos', 'uploader_name'));
      assert.ok(await runner.hasColumn('court_images', 'uploader_name'));

      // Tables the legacy database never had still get created.
      assert.ok(await runner.hasTable('sms_events'));
      assert.ok(await runner.hasTable('randomizer_messages'));

      const rerun = await runMigrations(runner, migrations);
      assert.deepEqual(rerun.applied, []);
    } finally {
      await close();
    }
  });
});

describe('migration list validation', () => {
  const noop = { up: async () => {} };

  it('rejects duplicate ids', async () => {
    const { runner, close } = openDatabase('duplicate');
    try {
      await assert.rejects(
        () => runMigrations(runner, [{ id: '001-a', ...noop }, { id: '001-a', ...noop }]),
        /Duplicate migration id/
      );
    } finally {
      await close();
    }
  });

  it('rejects a list that is out of order', async () => {
    const { runner, close } = openDatabase('order');
    try {
      await assert.rejects(
        () => runMigrations(runner, [{ id: '002-b', ...noop }, { id: '001-a', ...noop }]),
        /must be listed in id order/
      );
    } finally {
      await close();
    }
  });

  it('leaves nothing behind when a migration throws', async () => {
    const { runner, close } = openDatabase('failure');
    try {
      const failing = [
        { id: '001-ok', description: 'fine', up: (r) => r.run('CREATE TABLE kept (id TEXT)') },
        {
          id: '002-broken',
          description: 'boom',
          up: async (r) => {
            await r.run('CREATE TABLE half_made (id TEXT)');
            throw new Error('boom');
          }
        }
      ];
      await assert.rejects(() => runMigrations(runner, failing), /boom/);

      const names = await tableNames(runner);
      assert.ok(names.includes('kept'), 'the migration that succeeded stays applied');
      assert.ok(!names.includes('half_made'), 'the failed migration is rolled back whole');

      const rows = await runner.all(`SELECT id FROM ${MIGRATIONS_TABLE}`);
      assert.deepEqual(rows.map((row) => row.id), ['001-ok']);
    } finally {
      await close();
    }
  });
});
