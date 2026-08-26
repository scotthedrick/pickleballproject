const {
  isProduction,
  withPgClient,
  sqliteAll,
  sqliteRun
} = require('./context');
const {
  buildDeveloperRosters,
  editPlayerInGame,
  deletePlayerFromGame
} = require('../utils/dev-rosters');

function mapGameRow(row) {
  return {
    gameId: row.id,
    hostPhone: row.host_phone,
    data: typeof row.data === 'string' ? JSON.parse(row.data) : row.data,
    updatedAt: row.updated_at
  };
}

function mapRosterRow(row) {
  return {
    hostPhone: row.host_phone,
    playerPhone: row.player_phone,
    name: row.name || '',
    duprId: row.dupr_id || '',
    duprRating: row.dupr_rating,
    isAndroid: row.is_android,
    updatedAt: row.updated_at
  };
}

function mapHostRow(row) {
  return {
    phone: row.phone,
    name: row.name || '',
    updatedAt: row.updated_at
  };
}

async function getDeveloperRosterSources() {
  if (isProduction) {
    return withPgClient(async (client) => {
      const [games, roster, hosts] = await Promise.all([
        client.query('SELECT id, host_phone, data, updated_at FROM games'),
        client.query('SELECT * FROM host_roster'),
        client.query('SELECT * FROM hosts')
      ]);
      return {
        games: games.rows.map(mapGameRow),
        rosterRows: roster.rows.map(mapRosterRow),
        hosts: hosts.rows.map(mapHostRow)
      };
    });
  }

  const [games, rosterRows, hosts] = await Promise.all([
    sqliteAll('SELECT id, host_phone, data, updated_at FROM games'),
    sqliteAll('SELECT * FROM host_roster'),
    sqliteAll('SELECT * FROM hosts')
  ]);
  return {
    games: games.map(mapGameRow),
    rosterRows: rosterRows.map(mapRosterRow),
    hosts: hosts.map(mapHostRow)
  };
}

async function updatePostgresRosterRows(client, oldPhone, newPhone, name) {
  if (oldPhone === newPhone) {
    const result = await client.query(
      `UPDATE host_roster
       SET name = $2, updated_at = CURRENT_TIMESTAMP
       WHERE player_phone = $1`,
      [oldPhone, name]
    );
    return result.rowCount;
  }

  const rows = (await client.query(
    'SELECT * FROM host_roster WHERE player_phone = $1',
    [oldPhone]
  )).rows;
  for (const row of rows) {
    await client.query(
      `INSERT INTO host_roster
        (host_phone, player_phone, name, dupr_id, dupr_rating, is_android, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
       ON CONFLICT (host_phone, player_phone)
       DO UPDATE SET name = EXCLUDED.name,
                     dupr_id = COALESCE(host_roster.dupr_id, EXCLUDED.dupr_id),
                     dupr_rating = COALESCE(host_roster.dupr_rating, EXCLUDED.dupr_rating),
                     is_android = COALESCE(host_roster.is_android, EXCLUDED.is_android),
                     updated_at = CURRENT_TIMESTAMP`,
      [row.host_phone, newPhone, name, row.dupr_id, row.dupr_rating, row.is_android]
    );
  }
  await client.query('DELETE FROM host_roster WHERE player_phone = $1', [oldPhone]);
  return rows.length;
}

async function updateSqliteRosterRows(oldPhone, newPhone, name) {
  if (oldPhone === newPhone) {
    const result = await sqliteRun(
      `UPDATE host_roster
       SET name = ?, updated_at = CURRENT_TIMESTAMP
       WHERE player_phone = ?`,
      [name, oldPhone]
    );
    return result.changes;
  }

  const rows = await sqliteAll('SELECT * FROM host_roster WHERE player_phone = ?', [oldPhone]);
  for (const row of rows) {
    await sqliteRun(
      `INSERT INTO host_roster
        (host_phone, player_phone, name, dupr_id, dupr_rating, is_android, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT (host_phone, player_phone)
       DO UPDATE SET name = excluded.name,
                     dupr_id = COALESCE(host_roster.dupr_id, excluded.dupr_id),
                     dupr_rating = COALESCE(host_roster.dupr_rating, excluded.dupr_rating),
                     is_android = COALESCE(host_roster.is_android, excluded.is_android),
                     updated_at = CURRENT_TIMESTAMP`,
      [row.host_phone, newPhone, name, row.dupr_id, row.dupr_rating, row.is_android]
    );
  }
  await sqliteRun('DELETE FROM host_roster WHERE player_phone = ?', [oldPhone]);
  return rows.length;
}

function ensurePhoneAvailable(sources, oldPhone, newPhone) {
  if (oldPhone === newPhone) return;
  const directory = buildDeveloperRosters(sources);
  if (directory.players.some((player) => player.phone === newPhone)) {
    const error = new Error('Another player already uses that phone number.');
    error.code = 'PLAYER_PHONE_EXISTS';
    throw error;
  }
}

async function updateDeveloperPlayer(oldPhone, newPhone, name) {
  if (isProduction) {
    return withPgClient(async (client) => {
      await client.query('BEGIN');
      try {
        const [gameResult, rosterResult] = await Promise.all([
          client.query('SELECT id, host_phone, data, updated_at FROM games FOR UPDATE'),
          client.query('SELECT * FROM host_roster FOR UPDATE')
        ]);
        const sources = {
          games: gameResult.rows.map(mapGameRow),
          rosterRows: rosterResult.rows.map(mapRosterRow)
        };
        ensurePhoneAvailable(sources, oldPhone, newPhone);

        let gameOccurrences = 0;
        for (const record of sources.games) {
          const before = JSON.stringify(record.data);
          editPlayerInGame(record.data, oldPhone, newPhone, name, record.hostPhone);
          if (JSON.stringify(record.data) === before) continue;
          gameOccurrences += 1;
          await client.query(
            // version moves on every write to data, exactly as saveGame does. A signup that
            // was read before this bulk edit must be refused rather than quietly restoring
            // the player this just renamed or removed.
            'UPDATE games SET data = $1, version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
            [record.data, record.gameId]
          );
        }
        const hostRosters = await updatePostgresRosterRows(client, oldPhone, newPhone, name);
        await client.query('COMMIT');
        return { gameOccurrences, hostRosters };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  }

  await sqliteRun('BEGIN IMMEDIATE');
  try {
    const sources = await getDeveloperRosterSources();
    ensurePhoneAvailable(sources, oldPhone, newPhone);
    let gameOccurrences = 0;
    for (const record of sources.games) {
      const before = JSON.stringify(record.data);
      editPlayerInGame(record.data, oldPhone, newPhone, name, record.hostPhone);
      if (JSON.stringify(record.data) === before) continue;
      gameOccurrences += 1;
      await sqliteRun(
        // Same reason as the PostgreSQL branch: a write to data always moves the version.
        'UPDATE games SET data = ?, version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [JSON.stringify(record.data), record.gameId]
      );
    }
    const hostRosters = await updateSqliteRosterRows(oldPhone, newPhone, name);
    await sqliteRun('COMMIT');
    return { gameOccurrences, hostRosters };
  } catch (error) {
    await sqliteRun('ROLLBACK');
    throw error;
  }
}

async function deleteDeveloperPlayer(phone) {
  if (isProduction) {
    return withPgClient(async (client) => {
      await client.query('BEGIN');
      try {
        const rows = (await client.query(
          'SELECT id, host_phone, data, updated_at FROM games FOR UPDATE'
        )).rows.map(mapGameRow);
        let gameOccurrences = 0;
        for (const record of rows) {
          const removed = deletePlayerFromGame(record.data, phone, record.hostPhone);
          if (!removed) continue;
          gameOccurrences += removed;
          await client.query(
            // version moves on every write to data, exactly as saveGame does. A signup that
            // was read before this bulk edit must be refused rather than quietly restoring
            // the player this just renamed or removed.
            'UPDATE games SET data = $1, version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
            [record.data, record.gameId]
          );
        }
        const rosterResult = await client.query(
          'DELETE FROM host_roster WHERE player_phone = $1',
          [phone]
        );
        await client.query('COMMIT');
        return { gameOccurrences, hostRosters: rosterResult.rowCount };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  }

  await sqliteRun('BEGIN IMMEDIATE');
  try {
    const rows = (await sqliteAll(
      'SELECT id, host_phone, data, updated_at FROM games'
    )).map(mapGameRow);
    let gameOccurrences = 0;
    for (const record of rows) {
      const removed = deletePlayerFromGame(record.data, phone, record.hostPhone);
      if (!removed) continue;
      gameOccurrences += removed;
      await sqliteRun(
        // Same reason as the PostgreSQL branch: a write to data always moves the version.
        'UPDATE games SET data = ?, version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [JSON.stringify(record.data), record.gameId]
      );
    }
    const rosterResult = await sqliteRun(
      'DELETE FROM host_roster WHERE player_phone = ?',
      [phone]
    );
    await sqliteRun('COMMIT');
    return { gameOccurrences, hostRosters: rosterResult.changes };
  } catch (error) {
    await sqliteRun('ROLLBACK');
    throw error;
  }
}

async function deleteDeveloperHost(phone) {
  if (isProduction) {
    return withPgClient(async (client) => {
      await client.query('BEGIN');
      try {
        await client.query(
          'SELECT id FROM games WHERE host_phone = $1 FOR UPDATE',
          [phone]
        );
        const photoResult = await client.query(
          `DELETE FROM game_photos
           WHERE game_id IN (SELECT id FROM games WHERE host_phone = $1)`,
          [phone]
        );
        const reminderResult = await client.query(
          `DELETE FROM reminder_log
           WHERE game_id IN (SELECT id FROM games WHERE host_phone = $1)`,
          [phone]
        );
        const gameResult = await client.query(
          'DELETE FROM games WHERE host_phone = $1',
          [phone]
        );
        const rosterResult = await client.query(
          'DELETE FROM host_roster WHERE host_phone = $1',
          [phone]
        );
        const hostResult = await client.query('DELETE FROM hosts WHERE phone = $1', [phone]);
        await client.query('COMMIT');
        return {
          games: gameResult.rowCount,
          photos: photoResult.rowCount,
          reminders: reminderResult.rowCount,
          rosterEntries: rosterResult.rowCount,
          hostRecords: hostResult.rowCount
        };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  }

  await sqliteRun('BEGIN IMMEDIATE');
  try {
    const photoResult = await sqliteRun(
      `DELETE FROM game_photos
       WHERE game_id IN (SELECT id FROM games WHERE host_phone = ?)`,
      [phone]
    );
    const reminderResult = await sqliteRun(
      `DELETE FROM reminder_log
       WHERE game_id IN (SELECT id FROM games WHERE host_phone = ?)`,
      [phone]
    );
    const gameResult = await sqliteRun(
      'DELETE FROM games WHERE host_phone = ?',
      [phone]
    );
    const rosterResult = await sqliteRun(
      'DELETE FROM host_roster WHERE host_phone = ?',
      [phone]
    );
    const hostResult = await sqliteRun('DELETE FROM hosts WHERE phone = ?', [phone]);
    await sqliteRun('COMMIT');
    return {
      games: gameResult.changes,
      photos: photoResult.changes,
      reminders: reminderResult.changes,
      rosterEntries: rosterResult.changes,
      hostRecords: hostResult.changes
    };
  } catch (error) {
    await sqliteRun('ROLLBACK');
    throw error;
  }
}

/**
 * Copies chosen players onto one host's saved roster.
 *
 * DO NOTHING rather than DO UPDATE, deliberately. Everywhere else a host's own saved row is
 * treated as the deliberate version of a player's details (see database/roster.js), and this
 * runs against hosts who may already have a roster - so somebody the host has already named
 * keeps that name, and is reported back as skipped rather than silently rewritten.
 *
 * Sends nothing. Adding a player to a roster is not an invitation; the host texts people when
 * they create a game.
 *
 * @param {string} hostPhone
 * @param {Array<{phone: string, name?: string, duprId?: string, duprRating?: number|null}>} players
 * @returns {Promise<{added: string[], skipped: string[]}>}
 */
async function addPlayersToHostRoster(hostPhone, players) {
  const INSERT_POSTGRES = `
    INSERT INTO host_roster (host_phone, player_phone, name, dupr_id, dupr_rating, updated_at)
    VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
    ON CONFLICT (host_phone, player_phone) DO NOTHING`;
  const INSERT_SQLITE = `
    INSERT INTO host_roster (host_phone, player_phone, name, dupr_id, dupr_rating, updated_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT (host_phone, player_phone) DO NOTHING`;

  const values = (player) => [
    hostPhone,
    player.phone,
    player.name || null,
    player.duprId || null,
    player.duprRating == null || player.duprRating === '' ? null : Number(player.duprRating)
  ];

  const added = [];
  const skipped = [];

  if (isProduction) {
    return withPgClient(async (client) => {
      await client.query('BEGIN');
      try {
        for (const player of players) {
          const result = await client.query(INSERT_POSTGRES, values(player));
          (result.rowCount ? added : skipped).push(player.phone);
        }
        await client.query('COMMIT');
        return { added, skipped };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  }

  await sqliteRun('BEGIN IMMEDIATE');
  try {
    for (const player of players) {
      const result = await sqliteRun(INSERT_SQLITE, values(player));
      (result.changes ? added : skipped).push(player.phone);
    }
    await sqliteRun('COMMIT');
    return { added, skipped };
  } catch (error) {
    await sqliteRun('ROLLBACK');
    throw error;
  }
}

module.exports = {
  getDeveloperRosterSources,
  updateDeveloperPlayer,
  deleteDeveloperPlayer,
  deleteDeveloperHost,
  addPlayersToHostRoster
};
