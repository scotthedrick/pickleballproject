const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  chooseDeveloperRosterSource,
  buildDeveloperRosters,
  resolveStarterRosterPlayers,
  editPlayerInGame,
  deletePlayerFromGame
} = require('../utils/dev-rosters');

describe('developer roster directory', () => {
  it('uses live data by default in local development while allowing fixture isolation', () => {
    assert.equal(chooseDeveloperRosterSource(), 'production');
    assert.equal(
      chooseDeveloperRosterSource({ requestedSource: 'local' }),
      'local'
    );
    assert.equal(
      chooseDeveloperRosterSource({ configuredSource: 'local' }),
      'local'
    );
    assert.equal(
      chooseDeveloperRosterSource({
        configuredSource: 'local',
        requestedSource: 'production'
      }),
      'local'
    );
    assert.equal(
      chooseDeveloperRosterSource({
        production: true,
        configuredSource: 'local',
        requestedSource: 'local'
      }),
      'production'
    );
  });

  it('groups every player under each host and deduplicates the master roster', () => {
    const result = buildDeveloperRosters({
      games: [
        {
          hostPhone: '1111111111',
          updatedAt: '2026-01-01T00:00:00Z',
          data: {
            organizerName: 'Host One',
            players: [
              { name: 'Host One', phone: '1111111111', isOrganizer: true },
              { name: 'Signup Name', phone: '(222) 222-2222' }
            ],
            waitlist: [{ name: 'Waiting Player', phone: '3333333333' }]
          }
        },
        {
          hostPhone: '4444444444',
          updatedAt: '2026-02-01T00:00:00Z',
          data: {
            organizerName: 'Host Two',
            players: [{ name: 'Newer Signup Name', phone: '2222222222' }]
          }
        }
      ],
      rosterRows: [
        {
          hostPhone: '1111111111',
          playerPhone: '2222222222',
          name: 'Host Saved Name',
          updatedAt: '2025-01-01T00:00:00Z'
        }
      ]
    });

    assert.deepEqual(result.counts, { hosts: 2, players: 2, rosterEntries: 3 });
    assert.deepEqual(result.hosts[0], {
      phone: '1111111111',
      name: 'Host One',
      players: [
        // `saved` is what separates a row the host can be given or have taken away from
        // somebody who is only here because they turned up in one of the host's games.
        { phone: '2222222222', name: 'Host Saved Name', saved: true },
        { phone: '3333333333', name: 'Waiting Player', saved: false }
      ]
    });
    assert.deepEqual(result.players, [
      {
        phone: '2222222222',
        name: 'Host Saved Name',
        hostCount: 2,
        hostRosters: [
          { phone: '1111111111', name: 'Host One' },
          { phone: '4444444444', name: 'Host Two' }
        ]
      },
      {
        phone: '3333333333',
        name: 'Waiting Player',
        hostCount: 1,
        hostRosters: [{ phone: '1111111111', name: 'Host One' }]
      }
    ]);
  });

  it('lists a host set up in the developer area before they have created a game', () => {
    const result = buildDeveloperRosters({
      games: [],
      rosterRows: [],
      hosts: [{ phone: '(999) 888-7777', name: 'Brett Olson', updatedAt: '2026-08-26T00:00:00Z' }]
    });

    assert.deepEqual(result.counts, { hosts: 1, players: 0, rosterEntries: 0 });
    assert.deepEqual(result.hosts, [
      { phone: '9998887777', name: 'Brett Olson', players: [] }
    ]);
  });

  it('prefers the name typed in the developer area over a game organizer name', () => {
    const games = [{
      hostPhone: '9998887777',
      // Newer than the host record, to prove this is precedence and not recency.
      updatedAt: '2026-09-01T00:00:00Z',
      data: { organizerName: 'B. Olson', players: [] }
    }];
    const hosts = [{ phone: '9998887777', name: 'Brett Olson', updatedAt: '2026-08-26T00:00:00Z' }];

    assert.equal(buildDeveloperRosters({ games, hosts }).hosts[0].name, 'Brett Olson');
    // Without a host record the game still supplies the name, as it always has.
    assert.equal(buildDeveloperRosters({ games }).hosts[0].name, 'B. Olson');
  });

  it('resolves a starter roster from the directory and refuses what it does not know', () => {
    const sources = {
      games: [{
        hostPhone: '1111111111',
        updatedAt: '2026-01-01T00:00:00Z',
        data: {
          organizerName: 'Host One',
          players: [
            { name: 'Alice Smith', phone: '2222222222' },
            { name: 'Bob Jones', phone: '3333333333' }
          ]
        }
      }],
      rosterRows: [{
        hostPhone: '1111111111',
        playerPhone: '2222222222',
        name: 'Alice Smith',
        duprId: 'DUPR-9',
        duprRating: 4.25,
        updatedAt: '2026-02-01T00:00:00Z'
      }],
      hosts: [{ phone: '9998887777', name: 'Brett Olson', updatedAt: '2026-08-26T00:00:00Z' }]
    };

    const resolved = resolveStarterRosterPlayers(sources, '9998887777', [
      '(222) 222-2222',
      '2222222222',   // the same person again, in another format
      '3333333333',
      '9998887777',   // the host themselves
      '5550000000'    // nobody the app has ever seen
    ]);

    // DUPR details recorded by another host ride along; the duplicate collapses.
    assert.deepEqual(resolved.players, [
      { phone: '2222222222', name: 'Alice Smith', duprId: 'DUPR-9', duprRating: 4.25 },
      { phone: '3333333333', name: 'Bob Jones', duprId: '', duprRating: null }
    ]);
    assert.deepEqual(resolved.unknown, ['5550000000']);
    assert.equal(resolved.selfSelected, true);
  });

  it('edits and deletes non-organizer occurrences across every player state', () => {
    const game = {
      players: [
        { name: 'Organizer', phone: '2222222222', isOrganizer: true },
        { name: 'Old Name', phone: '1111111111' }
      ],
      waitlist: [{ name: 'Old Name', phone: '(111) 111-1111' }],
      outPlayers: [{ name: 'Someone Else', phone: '3333333333' }]
    };

    assert.equal(editPlayerInGame(game, '1111111111', '4444444444', 'New Name'), true);
    assert.deepEqual(game.players[1], { name: 'New Name', phone: '4444444444' });
    assert.deepEqual(game.waitlist[0], { name: 'New Name', phone: '4444444444' });
    assert.equal(editPlayerInGame(game, '2222222222', '5555555555', 'Not The Host'), false);

    assert.equal(deletePlayerFromGame(game, '4444444444'), 2);
    assert.equal(game.players.length, 1);
    assert.equal(game.waitlist.length, 0);
    assert.equal(deletePlayerFromGame(game, '2222222222'), 0);
    assert.equal(game.players[0].isOrganizer, true);
  });
});
