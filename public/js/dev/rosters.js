// The Hosts And Players tab: the master directory, and editing or removing people in it.
import { el, escapeHtml } from './shared.js';
import { sendJson, signedOut } from './api.js';

let rosterDirectory = { hosts: [], players: [], counts: {}, source: null };

// Reloading the tab replaces its markup wholesale, so which host cards were open and what the
// last action reported have to be remembered here or every add would slam the card shut and
// throw away its own result.
const openHostPhones = new Set();
const hostFlash = new Map();

function formatDisplayPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length !== 10) return phone || 'No phone number';
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

function rosterPlayerCard(player) {
  const hostRosters = Array.isArray(player.hostRosters) ? player.hostRosters : [];
  const hostNames = hostRosters.map((host) => host.name || formatDisplayPhone(host.phone));
  const hostLabel = hostNames.length === 1
    ? `Host Roster: ${hostNames[0]}`
    : `Host Rosters: ${hostNames.join(', ')}`;
  return `
    <article class="master-player" data-player-phone="${escapeHtml(player.phone)}">
      <div class="master-player-main">
        <div class="roster-person">
          <div class="roster-person-name">${escapeHtml(player.name || 'Name Not Available')}</div>
          <div class="roster-person-phone">${escapeHtml(formatDisplayPhone(player.phone))}</div>
          <div class="roster-person-meta">${escapeHtml(hostLabel)}</div>
        </div>
        <div class="roster-actions">
          <button type="button" class="ghost" data-roster-action="edit">Edit</button>
          <button type="button" class="danger-button" data-roster-action="delete">Delete</button>
        </div>
      </div>
      <form class="player-edit-form hidden">
        <div class="player-edit-fields">
          <label>Player Name
            <input name="name" value="${escapeHtml(player.name)}" maxlength="100" required>
          </label>
          <label>Phone Number
            <input name="phone" value="${escapeHtml(formatDisplayPhone(player.phone))}"
              inputmode="tel" autocomplete="tel" required>
          </label>
        </div>
        <div class="roster-actions">
          <button type="submit" class="primary">Save Changes</button>
          <button type="button" class="ghost" data-roster-action="cancel">Cancel</button>
        </div>
        <div class="roster-form-status" aria-live="polite"></div>
      </form>
      <div class="player-delete-confirm hidden">
        <p>
          This permanently removes <strong>${escapeHtml(player.name || formatDisplayPhone(player.phone))}</strong>
          from every host roster and every game roster. No text message will be sent.
        </p>
        <div class="roster-actions">
          <button type="button" class="danger-button" data-roster-action="confirm-delete">Delete Player</button>
          <button type="button" class="ghost" data-roster-action="cancel">Cancel</button>
        </div>
        <div class="roster-form-status" aria-live="polite"></div>
      </div>
    </article>`;
}

function renderRosters() {
  const query = el('rosterSearch').value.trim().toLowerCase();
  const matches = (name, phone) =>
    !query ||
    String(name || '').toLowerCase().includes(query) ||
    String(phone || '').includes(query.replace(/\D/g, ''));
  const visiblePlayers = rosterDirectory.players.filter((player) => matches(player.name, player.phone));

  el('rosterSearchCount').textContent = query
    ? `${visiblePlayers.length} of ${rosterDirectory.players.length} players`
    : `${rosterDirectory.players.length} players`;
  el('masterRosterList').innerHTML = visiblePlayers.length
    ? visiblePlayers.map(rosterPlayerCard).join('')
    : '<p class="muted">No players match that search.</p>';

  const visibleHosts = rosterDirectory.hosts
    .map((host) => ({
      ...host,
      players: query
        ? host.players.filter((player) => matches(player.name, player.phone))
        : host.players
    }))
    .filter((host) => !query || matches(host.name, host.phone) || host.players.length);

  el('hostRosterList').innerHTML = visibleHosts.length
    ? visibleHosts.map((host) => `
      <details class="host-roster" data-host-phone="${escapeHtml(host.phone)}"${query ? ' open' : ''}>
        <summary>
          <div class="roster-person">
            <div class="roster-person-name">${escapeHtml(host.name || 'Host Name Not Available')}</div>
            <div class="roster-person-phone">${escapeHtml(formatDisplayPhone(host.phone))}</div>
          </div>
          <div class="host-roster-summary-actions">
            <span class="host-roster-count">${host.players.length} player${host.players.length === 1 ? '' : 's'}</span>
            <button type="button" class="host-delete-button" data-host-action="delete">Delete</button>
          </div>
        </summary>
        <div class="host-delete-confirm hidden">
          <p>
            This permanently deletes <strong>${escapeHtml(host.name || formatDisplayPhone(host.phone))}</strong>
            as a host, including every game they host, game photo, reminder record, and saved roster entry.
            People listed with other hosts will remain there. No text message will be sent.
          </p>
          <div class="roster-actions">
            <button type="button" class="danger-button" data-host-action="confirm-delete">Delete Host</button>
            <button type="button" class="ghost" data-host-action="cancel">Cancel</button>
          </div>
          <div class="roster-form-status" aria-live="polite"></div>
        </div>
        <div class="host-roster-tools">
          <button type="button" class="ghost" data-host-action="pick">Add Players From Master Roster</button>
        </div>
        <div class="host-player-picker hidden" data-picker></div>
        <div class="host-roster-status" aria-live="polite"></div>
        <div class="host-roster-players">
          ${host.players.length ? host.players.map((player) => `
            <div class="host-roster-player" data-player-phone="${escapeHtml(player.phone)}">
              <span class="roster-person-name">${escapeHtml(player.name || 'Name Not Available')}</span>
              <span class="roster-person-phone">${escapeHtml(formatDisplayPhone(player.phone))}</span>
              ${player.saved
                ? '<button type="button" class="host-roster-remove" data-host-action="remove-player">Remove</button>'
                : '<span class="host-roster-from-game">From A Game</span>'}
            </div>`).join('') : '<p class="muted">No players on this roster.</p>'}
        </div>
      </details>`).join('')
    : '<p class="muted">No host rosters match that search.</p>';

  el('hostRosterList').querySelectorAll('.host-roster').forEach((card) => {
    const phone = card.dataset.hostPhone;
    if (openHostPhones.has(phone)) card.open = true;
    const flash = hostFlash.get(phone);
    if (flash) {
      const status = card.querySelector('.host-roster-status');
      status.textContent = flash.message;
      status.classList.toggle('good', !flash.failed);
    }
  });
}

// The people this host could still be given: everyone in the master directory who is not
// already on their roster, and never the host themselves.
function availableForHost(host) {
  const taken = new Set(host.players.map((player) => player.phone));
  return rosterDirectory.players.filter(
    (player) => player.phone !== host.phone && !taken.has(player.phone)
  );
}

function renderHostPicker(card, host) {
  const picker = card.querySelector('[data-picker]');
  const available = availableForHost(host);

  if (!available.length) {
    picker.innerHTML = `
      <p class="muted">Everybody in the master roster is already on this host's roster.</p>`;
    return;
  }

  picker.innerHTML = `
    <p class="muted">
      Tick the players this host should start with. They are copied onto the host's saved
      roster, so the picker on their management page lists them the first time they open it.
      Nobody is texted, and a player already on the roster keeps the name the host gave them.
    </p>
    <div class="roster-toolbar">
      <input type="search" class="host-picker-search"
        placeholder="Search by player name or phone number"
        aria-label="Search Players To Add">
      <span class="muted host-picker-count"></span>
    </div>
    <div class="host-picker-list">
      ${available.map((player) => `
        <label class="host-picker-option" data-player-phone="${escapeHtml(player.phone)}">
          <input type="checkbox" value="${escapeHtml(player.phone)}">
          <span class="roster-person-name">${escapeHtml(player.name || 'Name Not Available')}</span>
          <span class="roster-person-phone">${escapeHtml(formatDisplayPhone(player.phone))}</span>
        </label>`).join('')}
    </div>
    <div class="roster-actions">
      <button type="button" class="ghost" data-host-action="select-all">Select All Shown</button>
      <button type="button" class="primary" data-host-action="add-players" disabled>Add Selected Players</button>
      <button type="button" class="ghost" data-host-action="close-picker">Cancel</button>
    </div>
    <div class="roster-form-status host-picker-status" aria-live="polite"></div>`;

  filterHostPicker(card);
}

function filterHostPicker(card) {
  const picker = card.querySelector('[data-picker]');
  const search = picker.querySelector('.host-picker-search');
  if (!search) return;
  const query = search.value.trim().toLowerCase();
  const digits = query.replace(/\D/g, '');
  let shown = 0;

  picker.querySelectorAll('.host-picker-option').forEach((option) => {
    const name = option.querySelector('.roster-person-name').textContent.toLowerCase();
    const phone = option.dataset.playerPhone;
    const match = !query || name.includes(query) || (digits && phone.includes(digits));
    option.classList.toggle('hidden', !match);
    if (match) shown += 1;
  });

  const total = picker.querySelectorAll('.host-picker-option').length;
  picker.querySelector('.host-picker-count').textContent =
    query ? `${shown} of ${total} players` : `${total} players`;
  updatePickerSelection(card);
}

function updatePickerSelection(card) {
  const picker = card.querySelector('[data-picker]');
  const add = picker.querySelector('[data-host-action="add-players"]');
  if (!add) return;
  const selected = picker.querySelectorAll('input[type="checkbox"]:checked').length;
  add.disabled = selected === 0;
  add.textContent = selected
    ? `Add ${selected} Selected ${selected === 1 ? 'Player' : 'Players'}`
    : 'Add Selected Players';
}

function renderRosterSource() {
  const notice = el('rosterSourceNotice');
  if (!rosterDirectory.showSourceNotice) {
    notice.classList.add('hidden');
    return;
  }
  const showingProduction = rosterDirectory.source === 'production';
  notice.classList.remove('hidden');
  notice.classList.toggle('local', !showingProduction);
  el('rosterSourceTitle').textContent = showingProduction
    ? 'Showing Live Production Data'
    : 'Showing Local Test Data';
  el('rosterSourceDetail').textContent = showingProduction
    ? 'These are the real rosters from inorout.club. Edits and deletions affect the live app.'
    : 'These rows only exist in this computer’s SQLite test database.';
  const toggle = el('rosterSourceToggle');
  toggle.classList.toggle('hidden', !rosterDirectory.canChooseSource);
  toggle.textContent = showingProduction
    ? 'Show Local Test Data'
    : 'Show Live Production Data';
}

function rosterSourceQuery() {
  return rosterDirectory.source
    ? `?source=${encodeURIComponent(rosterDirectory.source)}`
    : '';
}

export async function loadRosters(requestedSource = null) {
  try {
    const query = requestedSource ? `?source=${encodeURIComponent(requestedSource)}` : '';
    const res = await fetch('/api/dev/rosters' + query);
    if (signedOut(res)) return;
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not load rosters.');
    rosterDirectory = data;
    renderRosterSource();
    el('rosterSummary').innerHTML = `
      <div class="stat good"><div class="label">Hosts</div>
        <div class="value">${data.counts.hosts}</div><div class="note">With a saved game or roster</div></div>
      <div class="stat good"><div class="label">Players</div>
        <div class="value">${data.counts.players}</div><div class="note">Unique phone numbers</div></div>
      <div class="stat"><div class="label">Roster Entries</div>
        <div class="value">${data.counts.rosterEntries}</div><div class="note">Across every host</div></div>`;
    renderRosters();
  } catch (err) {
    el('rosterSummary').innerHTML = '';
    if (requestedSource === 'production') {
      rosterDirectory = {
        ...rosterDirectory,
        source: 'production',
        showSourceNotice: true,
        canChooseSource: true
      };
      renderRosterSource();
    }
    el('masterRosterList').innerHTML = `<p class="muted">${escapeHtml(err.message)}</p>`;
    el('hostRosterList').innerHTML = '<p class="muted">Could not load host rosters.</p>';
  }
}

el('rosterSearch').addEventListener('input', renderRosters);
el('rosterSourceToggle').addEventListener('click', () => {
  loadRosters(rosterDirectory.source === 'production' ? 'local' : 'production');
});

el('hostRosterList').addEventListener('click', (event) => {
  const button = event.target.closest('[data-host-action]');
  if (!button) return;
  event.preventDefault();
  event.stopPropagation();

  const card = button.closest('.host-roster');
  const deleteConfirm = card.querySelector('.host-delete-confirm');
  const action = button.dataset.hostAction;

  if (action === 'pick') {
    const host = rosterDirectory.hosts.find((entry) => entry.phone === card.dataset.hostPhone);
    if (!host) return;
    const picker = card.querySelector('[data-picker]');
    card.open = true;
    openHostPhones.add(card.dataset.hostPhone);
    renderHostPicker(card, host);
    picker.classList.remove('hidden');
    picker.querySelector('.host-picker-search')?.focus();
  } else if (action === 'close-picker') {
    const picker = card.querySelector('[data-picker]');
    picker.classList.add('hidden');
    picker.innerHTML = '';
    card.querySelector('[data-host-action="pick"]').focus();
  } else if (action === 'select-all') {
    const picker = card.querySelector('[data-picker]');
    const shown = [...picker.querySelectorAll('.host-picker-option:not(.hidden) input[type="checkbox"]')];
    // A second press clears them, so this is also the way out of a 60-name selection.
    const turningOn = shown.some((box) => !box.checked);
    shown.forEach((box) => { box.checked = turningOn; });
    updatePickerSelection(card);
  } else if (action === 'add-players') {
    addSelectedPlayers(card, button);
  } else if (action === 'remove-player') {
    removeSavedPlayer(card, button);
  } else if (action === 'delete') {
    card.open = true;
    deleteConfirm.classList.remove('hidden');
    deleteConfirm.querySelector('[data-host-action="confirm-delete"]').focus();
  } else if (action === 'cancel') {
    deleteConfirm.classList.add('hidden');
    card.querySelector('[data-host-action="delete"]').focus();
  } else if (action === 'confirm-delete') {
    const phone = card.dataset.hostPhone;
    const status = deleteConfirm.querySelector('.roster-form-status');
    button.disabled = true;
    status.textContent = 'Deleting host…';
    sendJson('/api/dev/hosts/' + encodeURIComponent(phone) + rosterSourceQuery(), 'DELETE', { confirmPhone: phone }).then(async (res) => {
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not delete the host.');
      await loadRosters(rosterDirectory.source);
    }).catch((err) => {
      status.textContent = err.message;
      button.disabled = false;
    });
  }
});

el('masterRosterList').addEventListener('click', (event) => {
  const button = event.target.closest('[data-roster-action]');
  if (!button) return;
  const card = button.closest('.master-player');
  const editForm = card.querySelector('.player-edit-form');
  const deleteConfirm = card.querySelector('.player-delete-confirm');
  const action = button.dataset.rosterAction;

  if (action === 'edit') {
    deleteConfirm.classList.add('hidden');
    editForm.classList.remove('hidden');
    editForm.elements.name.focus();
  } else if (action === 'delete') {
    editForm.classList.add('hidden');
    deleteConfirm.classList.remove('hidden');
    deleteConfirm.querySelector('[data-roster-action="confirm-delete"]').focus();
  } else if (action === 'cancel') {
    editForm.classList.add('hidden');
    deleteConfirm.classList.add('hidden');
  } else if (action === 'confirm-delete') {
    const phone = card.dataset.playerPhone;
    const status = deleteConfirm.querySelector('.roster-form-status');
    button.disabled = true;
    status.textContent = 'Deleting player…';
    sendJson('/api/dev/players/' + encodeURIComponent(phone) + rosterSourceQuery(), 'DELETE', { confirmPhone: phone }).then(async (res) => {
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not delete the player.');
      await loadRosters(rosterDirectory.source);
    }).catch((err) => {
      status.textContent = err.message;
      button.disabled = false;
    });
  }
});

el('masterRosterList').addEventListener('submit', async (event) => {
  const form = event.target.closest('.player-edit-form');
  if (!form) return;
  event.preventDefault();
  const card = form.closest('.master-player');
  const oldPhone = card.dataset.playerPhone;
  const status = form.querySelector('.roster-form-status');
  const submit = form.querySelector('button[type="submit"]');
  submit.disabled = true;
  status.textContent = 'Saving changes…';

  try {
    const res = await sendJson(
      '/api/dev/players/' + encodeURIComponent(oldPhone) + rosterSourceQuery(),
      'PUT',
      { name: form.elements.name.value, phone: form.elements.phone.value }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not update the player.');
    await loadRosters(rosterDirectory.source);
  } catch (err) {
    status.textContent = err.message;
    submit.disabled = false;
  }
});

async function addSelectedPlayers(card, button) {
  const hostPhone = card.dataset.hostPhone;
  const picker = card.querySelector('[data-picker]');
  const status = picker.querySelector('.host-picker-status');
  const phones = [...picker.querySelectorAll('input[type="checkbox"]:checked')]
    .map((box) => box.value);

  if (!phones.length) return;
  button.disabled = true;
  status.classList.remove('good');
  status.textContent = `Adding ${phones.length} ${phones.length === 1 ? 'player' : 'players'}…`;

  try {
    const res = await sendJson(
      '/api/dev/hosts/' + encodeURIComponent(hostPhone) + '/roster' + rosterSourceQuery(),
      'POST',
      { phones }
    );
    if (signedOut(res)) return;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not add those players.');

    const parts = [`${data.added} added`];
    if (data.alreadyOnRoster) parts.push(`${data.alreadyOnRoster} already on the roster`);
    hostFlash.set(hostPhone, { message: parts.join(', ') + '.', failed: false });
    openHostPhones.add(hostPhone);
    await loadRosters(rosterDirectory.source);
  } catch (err) {
    status.textContent = err.message;
    button.disabled = false;
  }
}

async function removeSavedPlayer(card, button) {
  const hostPhone = card.dataset.hostPhone;
  const row = button.closest('.host-roster-player');
  const playerPhone = row.dataset.playerPhone;
  const status = card.querySelector('.host-roster-status');

  button.disabled = true;
  status.classList.remove('good');
  status.textContent = 'Removing…';

  try {
    const res = await sendJson(
      '/api/dev/hosts/' + encodeURIComponent(hostPhone) +
        '/roster/' + encodeURIComponent(playerPhone) + rosterSourceQuery(),
      'DELETE',
      {}
    );
    if (signedOut(res)) return;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not remove that player.');

    hostFlash.set(hostPhone, { message: 'Removed from this roster.', failed: false });
    openHostPhones.add(hostPhone);
    await loadRosters(rosterDirectory.source);
  } catch (err) {
    status.textContent = err.message;
    button.disabled = false;
  }
}

// Typing in a picker filters it; ticking a box updates the Add button's count.
el('hostRosterList').addEventListener('input', (event) => {
  const card = event.target.closest('.host-roster');
  if (!card) return;
  if (event.target.classList.contains('host-picker-search')) filterHostPicker(card);
});

el('hostRosterList').addEventListener('change', (event) => {
  const card = event.target.closest('.host-roster');
  if (!card || event.target.type !== 'checkbox') return;
  updatePickerSelection(card);
});

// A card the developer opened stays open across the reload that follows every action.
el('hostRosterList').addEventListener('toggle', (event) => {
  const card = event.target.closest('.host-roster');
  if (!card) return;
  if (card.open) openHostPhones.add(card.dataset.hostPhone);
  else {
    openHostPhones.delete(card.dataset.hostPhone);
    hostFlash.delete(card.dataset.hostPhone);
  }
}, true);

el('addHostForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target;
  const status = el('addHostStatus');
  const submit = form.querySelector('button[type="submit"]');
  const phone = form.elements.phone.value;

  submit.disabled = true;
  status.classList.remove('good');
  status.textContent = 'Adding host…';

  try {
    const res = await sendJson('/api/dev/hosts' + rosterSourceQuery(), 'POST', {
      name: form.elements.name.value,
      phone
    });
    if (signedOut(res)) return;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not add the host.');

    form.reset();
    const added = data.host || {};
    // Open the new host straight away: giving them a roster is the whole point of adding them.
    openHostPhones.add(added.phone);
    hostFlash.set(added.phone, {
      message: 'Host added. Now pick the players they should start with.',
      failed: false
    });
    status.classList.add('good');
    status.textContent = `${added.name} is set up under ${formatDisplayPhone(added.phone)}.`;
    await loadRosters(rosterDirectory.source);
    document.querySelector(`.host-roster[data-host-phone="${added.phone}"]`)
      ?.scrollIntoView({ block: 'center' });
  } catch (err) {
    status.textContent = err.message;
  } finally {
    submit.disabled = false;
  }
});
