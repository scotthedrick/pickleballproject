/**
 * The ordered migration list. Order here is the order they run in, and the runner refuses a
 * list whose ids are out of order, so keep the numeric prefixes ascending.
 *
 * To add a change: create `NNN-short-name.js` exporting `{ id, description, up(runner) }`,
 * append it below, and never edit a migration that has already run in production - write
 * the next one instead. `runner` is a MigrationRunner (see ../migration-runner.js): it
 * takes `?` placeholders in either dialect and exposes `isPostgres`, `pick()`, `exec()` and
 * `addColumnIfMissing()`.
 */

module.exports = [
  require('./001-baseline-schema'),
  require('./002-game-version'),
  require('./003-hosts')
];
