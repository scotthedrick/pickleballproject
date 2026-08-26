/**
 * A host record that does not depend on having hosted a game yet.
 *
 * Until now a host existed only as a side effect of `games.host_phone`, and their name
 * existed only inside a game's `organizerName`. That is fine for someone who arrived by
 * creating a game, but the developer area can now set a host up in advance - name them,
 * and hand them a starter roster - so that their very first visit to the management area
 * already lists the people they play with.
 *
 * A host seeded that way has no game to take a name from, so the name lives here. Phone
 * number is the identity, exactly as it is in `host_roster` and `games.host_phone`: the
 * number typed here has to be the number they later create a game with.
 *
 * This table is deliberately not a prerequisite for hosting. Everyone who has ever created
 * a game remains a host with no row here, and the directory unions the two.
 */

const POSTGRES_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS hosts (
    phone TEXT PRIMARY KEY,
    name TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`
];

const SQLITE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS hosts (
    phone TEXT PRIMARY KEY,
    name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`
];

module.exports = {
  id: '003-hosts',
  description: 'hosts table so a host can be set up before they have created a game',
  async up(runner) {
    await runner.exec(runner.isPostgres ? POSTGRES_STATEMENTS : SQLITE_STATEMENTS);
  }
};
