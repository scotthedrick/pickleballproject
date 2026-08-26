// Host records created ahead of their first game (see migration 003-hosts).
//
// Nothing here decides who may host. A host who arrived the ordinary way - by creating a
// game - has no row in this table and never needs one; `games.host_phone` is still what
// makes somebody a host. These rows exist so the developer area can name a host and give
// them a starter roster before they have created anything, and so that name survives
// until their first game supplies one.

const { isProduction, withPgClient, sqliteAll, sqliteGet, sqliteRun } = require('./context');

function toHost(row) {
  return {
    phone: row.phone,
    name: row.name || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

// A blank name would be worse than no row at all: the directory falls back to the name a
// game supplies, and storing '' here would win over it. Store null instead.
async function upsertHost(phone, name) {
  const cleanName = name == null ? null : String(name).trim().slice(0, 100) || null;
  if (isProduction) {
    return withPgClient(async (client) => {
      await client.query(`
        INSERT INTO hosts (phone, name, created_at, updated_at)
        VALUES ($1, $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT (phone)
        DO UPDATE SET name = COALESCE(EXCLUDED.name, hosts.name),
                      updated_at = CURRENT_TIMESTAMP
      `, [phone, cleanName]);
    });
  }
  await sqliteRun(`
    INSERT INTO hosts (phone, name, created_at, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT (phone)
    DO UPDATE SET name = COALESCE(excluded.name, hosts.name),
                  updated_at = CURRENT_TIMESTAMP
  `, [phone, cleanName]);
}

async function listHosts() {
  if (isProduction) {
    const rows = await withPgClient(async (client) => {
      const result = await client.query('SELECT * FROM hosts');
      return result.rows;
    });
    return rows.map(toHost);
  }
  return (await sqliteAll('SELECT * FROM hosts')).map(toHost);
}

async function getHost(phone) {
  if (isProduction) {
    const rows = await withPgClient(async (client) => {
      const result = await client.query('SELECT * FROM hosts WHERE phone = $1', [phone]);
      return result.rows;
    });
    return rows.length ? toHost(rows[0]) : null;
  }
  const row = await sqliteGet('SELECT * FROM hosts WHERE phone = ?', [phone]);
  return row ? toHost(row) : null;
}

async function deleteHost(phone) {
  if (isProduction) {
    return withPgClient(async (client) => {
      const result = await client.query('DELETE FROM hosts WHERE phone = $1', [phone]);
      return result.rowCount;
    });
  }
  return (await sqliteRun('DELETE FROM hosts WHERE phone = ?', [phone])).changes;
}

module.exports = { upsertHost, listHosts, getHost, deleteHost };
