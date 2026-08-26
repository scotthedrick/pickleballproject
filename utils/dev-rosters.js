const { formatPhoneNumber } = require('./sms-format');

const PLAYER_LIST_FIELDS = ['players', 'waitlist', 'outPlayers', 'invitedPlayers'];

function chooseDeveloperRosterSource({
  production = false,
  configuredSource = '',
  requestedSource = ''
} = {}) {
  if (production) return 'production';
  // The screenshot and browser-test server sets this hard lock so no test action or query
  // string can ever redirect a fixture mutation to the live production database.
  if (configuredSource === 'local') return 'local';
  if (requestedSource === 'local' || requestedSource === 'production') return requestedSource;
  return 'production';
}

function cleanPhone(value) {
  const phone = formatPhoneNumber(value);
  return phone.length === 10 ? phone : '';
}

function sourceTime(value) {
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? time : 0;
}

function playerEntries(game) {
  return PLAYER_LIST_FIELDS.flatMap((field) =>
    Array.isArray(game[field]) ? game[field].map((player) => ({ field, player })) : []
  );
}

function buildDeveloperRosters({ games = [], rosterRows = [], hosts: hostRecords = [] } = {}) {
  const hostsByPhone = new Map();
  const masterByPhone = new Map();

  function ensureHost(phone) {
    if (!hostsByPhone.has(phone)) {
      hostsByPhone.set(phone, {
        phone,
        name: '',
        nameTime: 0,
        // 1 = taken from a game's organizerName, 2 = typed into the developer area.
        namePriority: 0,
        playersByPhone: new Map()
      });
    }
    return hostsByPhone.get(phone);
  }

  function noteMaster(phone, name, time, priority) {
    const current = masterByPhone.get(phone);
    const cleanName = String(name || '').trim();
    if (!current) {
      masterByPhone.set(phone, {
        phone,
        name: cleanName,
        nameTime: time,
        namePriority: priority,
        hostPhones: new Set()
      });
      return masterByPhone.get(phone);
    }
    if (
      cleanName &&
      (!current.name || priority > current.namePriority ||
        (priority === current.namePriority && time >= current.nameTime))
    ) {
      current.name = cleanName;
      current.nameTime = time;
      current.namePriority = priority;
    }
    return current;
  }

  // `saved` marks a row that exists in host_roster, as opposed to a player who is only
  // visible because they appear in one of the host's games. The developer area can remove
  // the first kind and not the second, so the distinction has to survive the merge.
  function noteHostPlayer(host, phone, name, time, priority, saved = false) {
    const current = host.playersByPhone.get(phone);
    const cleanName = String(name || '').trim();
    if (!current) {
      host.playersByPhone.set(phone, {
        phone,
        name: cleanName,
        nameTime: time,
        namePriority: priority,
        saved
      });
    } else if (
      cleanName &&
      (!current.name || priority > current.namePriority ||
        (priority === current.namePriority && time >= current.nameTime))
    ) {
      current.name = cleanName;
      current.nameTime = time;
      current.namePriority = priority;
    }
    if (saved && current) current.saved = true;
    noteMaster(phone, cleanName, time, priority).hostPhones.add(host.phone);
  }

  for (const record of games) {
    const game = record.data || {};
    const hostPhone = cleanPhone(record.hostPhone || game.hostPhone || game.organizerPhone);
    if (!hostPhone) continue;

    const host = ensureHost(hostPhone);
    const time = sourceTime(record.updatedAt || game.created || game.date);
    const hostName = String(game.organizerName || '').trim();
    if (hostName && host.namePriority <= 1 && (!host.name || time >= host.nameTime)) {
      host.name = hostName;
      host.nameTime = time;
      host.namePriority = 1;
    }

    for (const { player } of playerEntries(game)) {
      const phone = cleanPhone(player && player.phone);
      if (!phone || phone === hostPhone || player.isOrganizer === true) continue;
      noteHostPlayer(
        host,
        phone,
        player.name,
        sourceTime(player.joinedAt || player.outAt || record.updatedAt || game.created || game.date),
        1
      );
    }
  }

  // Hosts set up in the developer area. Two things bring them in here: a host who has not
  // created a game yet exists only in this list, and a name typed in the developer area is
  // deliberate, so it wins over whatever organizerName a game happens to carry.
  for (const record of hostRecords) {
    const phone = cleanPhone(record && record.phone);
    if (!phone) continue;
    const host = ensureHost(phone);
    const name = String((record && record.name) || '').trim();
    if (name) {
      host.name = name;
      host.nameTime = sourceTime(record.updatedAt);
      host.namePriority = 2;
    }
  }

  // A saved roster entry is the host's deliberate version of a player's details, so it
  // takes precedence over names captured from a signup even when the game is newer.
  for (const row of rosterRows) {
    const hostPhone = cleanPhone(row.hostPhone);
    const playerPhone = cleanPhone(row.playerPhone);
    if (!hostPhone || !playerPhone || hostPhone === playerPhone) continue;
    const host = ensureHost(hostPhone);
    noteHostPlayer(host, playerPhone, row.name, sourceTime(row.updatedAt), 2, true);
  }

  const byNameThenPhone = (a, b) =>
    (a.name || a.phone).localeCompare(b.name || b.phone, undefined, { sensitivity: 'base' }) ||
    a.phone.localeCompare(b.phone);

  const hosts = [...hostsByPhone.values()]
    .map((host) => ({
      phone: host.phone,
      name: host.name,
      players: [...host.playersByPhone.values()]
        .map(({ phone, name, saved }) => ({ phone, name, saved: Boolean(saved) }))
        .sort(byNameThenPhone)
    }))
    .sort(byNameThenPhone);

  const players = [...masterByPhone.values()]
    .map((player) => ({
      phone: player.phone,
      name: player.name,
      hostCount: player.hostPhones.size,
      hostRosters: [...player.hostPhones]
        .map((phone) => {
          const host = hostsByPhone.get(phone);
          return { phone, name: host ? host.name : '' };
        })
        .sort(byNameThenPhone)
    }))
    .sort(byNameThenPhone);

  return {
    hosts,
    players,
    counts: {
      hosts: hosts.length,
      players: players.length,
      rosterEntries: hosts.reduce((sum, host) => sum + host.players.length, 0)
    }
  };
}

/**
 * Works out what to write when the developer area seeds a host's starter roster.
 *
 * The caller sends phone numbers only. Names and DUPR details are resolved here, from what
 * the app already knows, for two reasons: the browser must not be able to invent a name for
 * a number, and a player carried over from another host's roster should arrive with the DUPR
 * details somebody has already taken the trouble to record.
 *
 * A number nobody has ever played with is reported back as unknown rather than silently
 * created - the picker only ever offers real people, so an unknown number means the caller
 * and the directory disagree and the write should be refused.
 *
 * @returns {{players: Array<object>, unknown: string[], selfSelected: boolean}}
 */
function resolveStarterRosterPlayers(sources, hostPhone, requestedPhones = []) {
  const host = cleanPhone(hostPhone);
  const directory = buildDeveloperRosters(sources);
  const knownNames = new Map(directory.players.map((player) => [player.phone, player.name]));

  // The most recently updated saved row wins for DUPR, whichever host recorded it.
  const details = new Map();
  for (const row of sources.rosterRows || []) {
    const phone = cleanPhone(row.playerPhone);
    if (!phone || (!row.duprId && row.duprRating == null)) continue;
    const time = sourceTime(row.updatedAt);
    const current = details.get(phone);
    if (!current || time >= current.time) {
      details.set(phone, { time, duprId: row.duprId || '', duprRating: row.duprRating });
    }
  }

  const players = [];
  const unknown = [];
  const seen = new Set();
  let selfSelected = false;

  for (const requested of requestedPhones) {
    const phone = cleanPhone(requested);
    if (!phone || seen.has(phone)) continue;
    seen.add(phone);
    if (phone === host) {
      selfSelected = true;
      continue;
    }
    if (!knownNames.has(phone)) {
      unknown.push(String(requested));
      continue;
    }
    const detail = details.get(phone) || {};
    players.push({
      phone,
      name: knownNames.get(phone) || '',
      duprId: detail.duprId || '',
      duprRating: detail.duprRating == null ? null : detail.duprRating
    });
  }

  return { players, unknown, selfSelected };
}

function editPlayerInGame(game, oldPhone, newPhone, name, hostPhone = '') {
  let changed = false;
  const cleanHostPhone = cleanPhone(hostPhone || game.hostPhone || game.organizerPhone);
  for (const { player } of playerEntries(game)) {
    if (
      !player ||
      player.isOrganizer === true ||
      cleanPhone(player.phone) === cleanHostPhone ||
      cleanPhone(player.phone) !== oldPhone
    ) continue;
    player.phone = newPhone;
    player.name = name;
    changed = true;
  }
  return changed;
}

function deletePlayerFromGame(game, phone, hostPhone = '') {
  let removed = 0;
  const cleanHostPhone = cleanPhone(hostPhone || game.hostPhone || game.organizerPhone);
  for (const field of PLAYER_LIST_FIELDS) {
    if (!Array.isArray(game[field])) continue;
    const kept = game[field].filter((player) => {
      const playerPhone = cleanPhone(player && player.phone);
      const matches = player &&
        player.isOrganizer !== true &&
        playerPhone !== cleanHostPhone &&
        playerPhone === phone;
      if (matches) removed += 1;
      return !matches;
    });
    if (kept.length !== game[field].length) game[field] = kept;
  }
  return removed;
}

module.exports = {
  PLAYER_LIST_FIELDS,
  chooseDeveloperRosterSource,
  buildDeveloperRosters,
  resolveStarterRosterPlayers,
  editPlayerInGame,
  deletePlayerFromGame
};
