const cdp = require('./lib/cdp');
const server = require('./lib/local-server');
const fixtures = require('./lib/fixtures');

function assert(value, message) {
  if (!value) throw new Error(message);
  console.log(`  PASS  ${message}`);
}

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const JPEG_BYTES = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
  Buffer.from('JFIF\0', 'ascii'),
  Buffer.alloc(32, 0x20),
  Buffer.from([0xff, 0xd9]),
]);

async function uploadCourtImage(baseUrl, game, bytes, contentType) {
  const response = await fetch(
    `${baseUrl}/api/games/${game.gameId}/court-images?token=${game.hostToken}`,
    { method: 'POST', headers: { 'Content-Type': contentType }, body: bytes }
  );
  if (!response.ok) {
    throw new Error(`court image fixture upload failed: HTTP ${response.status}`);
  }
  return response.json();
}

async function uploadGamePhoto(baseUrl, game, bytes, contentType, caption) {
  const query = new URLSearchParams({ token: game.hostToken, caption });
  const response = await fetch(
    `${baseUrl}/api/games/${game.gameId}/photos?${query}`,
    { method: 'POST', headers: { 'Content-Type': contentType }, body: bytes }
  );
  if (!response.ok) {
    throw new Error(`game photo fixture upload failed: HTTP ${response.status}`);
  }
  return response.json();
}

(async () => {
  // An empty database of its own, migrated and seeded at boot the way any new one is. Every
  // count this file pins - the shipped You're IN messages, the courts in the create page's
  // picker, the images in the developer inventory - is then decided by the code and the
  // fixtures below, never by what a developer happens to have saved locally. local.stop()
  // deletes the whole database afterwards, which is why nothing here sweeps fixture rows.
  const local = await server.start({ isolatedDatabase: true });
  let browser;
  try {
    const [createPageResponse, createScriptResponse] = await Promise.all([
      fetch(`${local.baseUrl}/create.html`),
      fetch(`${local.baseUrl}/js/create.js?v=cache-policy-check`)
    ]);
    assert(
      /no-cache/.test(createPageResponse.headers.get('cache-control') || '') &&
        /no-cache/.test(createScriptResponse.headers.get('cache-control') || ''),
      'HTML and JavaScript revalidate together after a deploy'
    );

    const fx = await fixtures.seed(local.baseUrl);
    const verificationRequest = await fetch(`${local.baseUrl}/api/host-verification/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: fx.HOST_PHONE })
    }).then((response) => response.json());
    const hostSession = await fetch(`${local.baseUrl}/api/host-verification/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: fx.HOST_PHONE, code: verificationRequest.devCode })
    }).then((response) => response.json());
    assert(Boolean(hostSession.token), 'host phone verification issues a private browser session');
    const [privateRandomizer, publicPersonalities] = await Promise.all([
      fetch(`${local.baseUrl}/api/dev/message-randomizer`),
      fetch(`${local.baseUrl}/api/message-personalities`).then((response) => response.json())
    ]);
    assert(
      privateRandomizer.status === 401 &&
        publicPersonalities.personalities.length === 1 &&
        Object.keys(publicPersonalities.personalities[0]).sort().join('|') ===
          'description|id|isDefault|name',
      'randomizer prompts, inventory, targeting, and phones stay behind Developer authentication'
    );
    const firstCourtImage = await uploadCourtImage(
      local.baseUrl, fx.open, PNG_1PX, 'image/png'
    );
    const secondCourtImage = await uploadCourtImage(
      local.baseUrl, fx.open, JPEG_BYTES, 'image/jpeg'
    );
    const firstGamePhoto = await uploadGamePhoto(
      local.baseUrl, fx.open, PNG_1PX, 'image/png', 'Doubles at sunset'
    );
    const secondGamePhoto = await uploadGamePhoto(
      local.baseUrl, fx.open, JPEG_BYTES, 'image/jpeg', 'The winning court'
    );

    await fetch(`${local.baseUrl}/api/games/${fx.open.gameId}/players`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: '<img src=x onerror="window.__unsafe=true">',
        phone: ''
      })
    });

    browser = await cdp.launch({ port: 9333 });
    const desktop = await browser.newPage({ width: 1100, height: 900 });

    await desktop.goto(`${local.baseUrl}/create.html`);
    const createReady = await desktop.evaluate(`(() => {
      const mode = document.querySelector('[data-radio-id="waitlistMode"]');
      mode.click();
      return {
        form: Boolean(document.getElementById('gameForm')),
        selected: document.getElementById('waitlistMode').checked,
        locationPlaceholderRemoved: !document.getElementById('location').hasAttribute('placeholder'),
        waitlistNotificationDefault: document.getElementById('notifyWaitlistStarts').checked &&
          document.querySelector('[data-checkbox-id="notifyWaitlistStarts"]').classList.contains('checked'),
        notificationTitles: [...document.querySelectorAll('.notifications-section .notification-title')]
          .map((element) => element.textContent.trim()),
        scriptExternal: [...document.scripts].some(
          (script) => new URL(script.src).pathname === '/js/create.js'
        ),
        personalityControlGone: !document.getElementById('personalityId'),
        headerSlogan: document.querySelector('.header-slogan')?.textContent.trim(),
        footerSlogan: document.querySelector('.footer-slogan')?.textContent.trim(),
        localNotice: document.querySelector('.local-preview-notice')?.textContent.trim(),
        liveLink: document.querySelector('.local-preview-notice a')?.href
      };
    })()`);
    assert(createReady.form && createReady.selected, 'create form and extracted handlers work');
    assert(createReady.locationPlaceholderRemoved, 'new-location field has no sample text');
    assert(createReady.waitlistNotificationDefault, 'waitlist-start notification is enabled by default');
    assert(
      createReady.notificationTitles.join('|') === [
        'Game Becomes Full',
        'Someone Cancels Their Spot',
        'Someone Joins The Game',
        'Only One Spot Remaining',
        'Waitlist Starts'
      ].join('|'),
      'organizer notification titles capitalize every word'
    );
    assert(createReady.scriptExternal, 'create page uses its external script');
    assert(
      createReady.personalityControlGone,
      'create form offers no personality choice - Realist is applied automatically'
    );
    assert(
      createReady.headerSlogan &&
        createReady.headerSlogan === createReady.footerSlogan &&
        !createReady.headerSlogan.includes('{NAME}'),
      'one resolved slogan is shared by the header and footer'
    );
    assert(
      createReady.localNotice?.includes('local test copy') &&
        createReady.liveLink === 'https://inorout.club/create.html',
      'local pages identify their test data and link to the matching live page'
    );

    await desktop.evaluate(`(() => {
      const select = document.getElementById('locationSelect');
      select.value = 'Oak Park Courts';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await cdp.sleep(500);
    const courtGallery = await desktop.evaluate(`(() => {
      const panel = document.getElementById('courtImageContainer');
      const savedPhotos = [...document.querySelectorAll(
        '.court-image-choice--photo'
      )];
      return {
        visible: !panel.hidden && getComputedStyle(panel).display !== 'none',
        savedPhotos: savedPhotos.length,
        uploadRemoved: !document.getElementById('courtImageUpload'),
        firstPhotoSelected: savedPhotos[0]?.querySelector('input').checked === true,
        noImageRemoved: !document.querySelector('input[value="none"]')
      };
    })()`);
    assert(
      courtGallery.visible && courtGallery.savedPhotos === 2 && courtGallery.firstPhotoSelected,
      'create form shows every saved court image and defaults to the first one'
    );
    assert(courtGallery.uploadRemoved && courtGallery.noImageRemoved,
      'create form has no court-image upload or No image choice');

    await desktop.evaluate(`(() => {
      const set = (id, value) => {
        const field = document.getElementById(id);
        field.value = value;
        field.dispatchEvent(new Event('input', { bubbles: true }));
      };
      const select = document.getElementById('locationSelect');
      select.value = '__new__';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      set('location', 'Sunset Park Courts');
    })()`);
    await cdp.sleep(500);
    const emptyGallery = await desktop.evaluate(`(() => ({
      panelVisible: !document.getElementById('courtImageContainer').hidden,
      choices: document.querySelectorAll('input[name="selectedCourtImage"]').length,
      uploadRemoved: !document.getElementById('courtImageUpload')
    }))()`);
    assert(!emptyGallery.panelVisible && emptyGallery.choices === 0 && emptyGallery.uploadRemoved,
      'a court with no saved photos does not show an empty image panel or upload');

    await desktop.evaluate(`(() => {
      const set = (id, value) => {
        const field = document.getElementById(id);
        field.value = value;
        field.dispatchEvent(new Event('input', { bubbles: true }));
      };
      const originalFetch = window.fetch.bind(window);
      window.__createPostKeys = [];
      window.fetch = async (url, options = {}) => {
        if (url === '/api/games' && options.method === 'POST') {
          window.__createPostKeys.push(options.headers?.['Idempotency-Key']);
          sessionStorage.setItem('__createPostKeys', JSON.stringify(window.__createPostKeys));
          const response = await originalFetch(url, options);
          if (window.__createPostKeys.length === 1) {
            throw new TypeError('Load failed');
          }
          return response;
        }
        return originalFetch(url, options);
      };
      set('organizerName', 'Upload Test Host');
      set('organizerPhone', '${fx.FORM_PHONE}');
      set('date', '${fx.date}');
      set('time', '17:30');
      set('players', '3');
      set('message', '${fx.MARKER}');
      document.getElementById('gameForm').requestSubmit();
    })()`);
    await cdp.sleep(150);
    const createLoading = await desktop.evaluate(`(() => ({
      visible: !document.getElementById('createLoadingOverlay').hidden,
      busy: document.getElementById('gameForm').getAttribute('aria-busy'),
      submitDisabled: document.querySelector('#gameForm button[type="submit"]').disabled,
      loadingTitle: document.querySelector('.create-loading-card h2').textContent.trim(),
      hasPickleball: Boolean(document.querySelector('.create-loading-card .pickleball-spinner'))
    }))()`);
    assert(
      createLoading.visible && createLoading.busy === 'true' && createLoading.submitDisabled &&
        createLoading.loadingTitle === 'Creating Your Game...' && createLoading.hasPickleball,
      'submitting immediately covers the form with an accessible pickleball loading screen'
    );
    await cdp.sleep(2500);
    const noImageResult = await desktop.evaluate(`(async () => {
      const params = new URLSearchParams(location.search);
      const gameId = params.get('id');
      const response = await fetch('/api/games/' + gameId + '/court-images');
      const library = await response.json();
      // The token matters here: notificationPreferences is host-only, so the public
      // response no longer carries it. The manage page strips the token from the URL at
      // load, so the token it captured is the way in. It used to be read from the page's
      // hostAuthHeaders(), a function that only existed because the page ran on globals;
      // ManageApp.state is the seam the page actually offers.
      const gameResponse = await fetch('/api/games/' + gameId, {
        headers: { 'X-Host-Token': ManageApp.state.hostToken }
      });
      const game = await gameResponse.json();
      return {
        gameId,
        imageCount: library.images.length,
        selectedImageId: library.selectedImageId,
        totalPlayers: game.totalPlayers,
        confirmedPlayers: game.players.length,
        waitlistNotificationSaved: game.notificationPreferences?.waitlistStarts === true,
        createPostKeys: JSON.parse(sessionStorage.getItem('__createPostKeys') || '[]')
      };
    })()`);
    assert(
      noImageResult.gameId && noImageResult.imageCount === 0 && !noImageResult.selectedImageId,
      'a game with no saved court photo still creates without an image'
    );
    assert(noImageResult.waitlistNotificationSaved,
      'the waitlist-start notification default is saved with the game');
    assert(
      noImageResult.totalPlayers === 4 && noImageResult.confirmedPlayers === 1,
      'three additional players plus the playing organizer creates a four-player game'
    );
    assert(
      noImageResult.createPostKeys.length === 2 &&
      noImageResult.createPostKeys[0] === noImageResult.createPostKeys[1],
      'a dropped creation response retries safely with the same idempotency key'
    );
    const createLanding = await desktop.evaluate(`(() => ({
      path: location.pathname,
      tab: new URLSearchParams(location.search).get('tab'),
      heading: document.querySelector('.page-header h1').textContent.trim(),
      inviteActive: document.getElementById('Invite').classList.contains('active'),
      status: document.getElementById('status').textContent.trim(),
      hasCopyInvitation: Boolean(document.getElementById('copyPlayerLink'))
    }))()`);
    assert(
      createLanding.path === '/manage.html' && createLanding.tab === 'Invite' &&
        createLanding.heading === 'Game Management' && createLanding.inviteActive &&
        createLanding.status === 'Game created.' &&
        createLanding.hasCopyInvitation,
      'successful creation lands directly on the Game Management Invite tab'
    );

    for (const player of [
      { phone: fx.JOIN_PHONE, name: 'Roster Player One', duprRating: 3.5 },
      { phone: fx.FORM_PHONE, name: 'Roster Player Two', duprRating: 4.1 }
    ]) {
      const response = await fetch(
        `${local.baseUrl}/api/roster/${fx.HOST_PHONE}/${player.phone}`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${hostSession.token}`
          },
          body: JSON.stringify(player)
        }
      );
      assert(response.ok, `${player.name} is available in the host roster fixture`);
    }

    // The smoke server keeps SMS event logging off, so the delivery log gets one seeded row:
    // a reminder that failed, which is exactly the case a host goes looking for.
    await fixtures.seedSmsEvent({
      gameId: fx.open.gameId,
      eventId: 'upcoming-game-reminder',
      phone: fx.JOIN_PHONE,
      status: 'failed',
      attempts: 3,
      error: 'Carrier rejected the message',
      dbFile: local.dbFile
    });

    // Someone who said OUT and left a phone number - the audience for "a spot just opened".
    await fetch(`${local.baseUrl}/api/games/${fx.open.gameId}/players`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Out Player', phone: '5555550888', action: 'out' })
    });
    await fixtures.removeSavedRosterFixture(fx.HOST_PHONE, '5555550888', local.dbFile);

    // Reproduce the reported group size through the real API. This separate fixture keeps its
    // invitation history from changing the management-screen assertions below.
    const inviteGroupGame = await fetch(`${local.baseUrl}/api/games`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        location: 'Three Player Invite Test',
        organizerName: 'Scott H.',
        organizerPhone: fx.HOST_PHONE,
        organizerPlaying: true,
        date: fx.date,
        time: '19:00',
        duration: 90,
        totalPlayers: 4,
        message: fx.MARKER,
        registrationMode: 'fcfs'
      })
    }).then((response) => response.json());
    const inviteRoster = await fetch(`${local.baseUrl}/api/roster/${fx.HOST_PHONE}`, {
      headers: {
        'X-Game-Id': inviteGroupGame.gameId,
        'X-Host-Token': inviteGroupGame.hostToken
      }
    }).then((response) => response.json());
    const invitePhones = inviteRoster.roster.slice(0, 3).map((person) => person.phone);
    const inviteGroupStartedAt = Date.now();
    const inviteGroupResponse = await fetch(
      `${local.baseUrl}/api/games/${inviteGroupGame.gameId}/invitations`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: inviteGroupGame.hostToken,
          playerPhones: invitePhones
        })
      }
    );
    const inviteGroup = await inviteGroupResponse.json();
    const recordedInvitePhones = new Set(
      (inviteGroup.invitedPlayers || []).map((person) => person.phone)
    );
    assert(
      invitePhones.length === 3 && inviteGroupResponse.status === 200 &&
        inviteGroup.sentCount === 3 && inviteGroup.failedCount === 0 &&
        invitePhones.every((phone) => recordedInvitePhones.has(phone)),
      `three selected players, including an older-game roster entry, are texted and recorded ` +
        `in one request ` +
        `(${Date.now() - inviteGroupStartedAt}ms in dev mode)`
    );

    await desktop.goto(
      `${local.baseUrl}/manage.html?id=${fx.open.gameId}&token=${fx.open.hostToken}`
    );
    await cdp.sleep(500);
    const manageTokenHidden = await desktop.evaluate(
      `(() => !location.search.includes('token='))()`
    );
    assert(manageTokenHidden, 'the management page removes the host token from the address bar');
    const manageReady = await desktop.evaluate(`(() => {
      const name = [...document.querySelectorAll('.player-name')]
        .find((node) => node.textContent.startsWith('<img'));
      const imageChoiceWidth = document.querySelector('.court-image-choice--photo')
        ?.getBoundingClientRect().width;
      const noImageWidth = document.getElementById('noImageOption')?.getBoundingClientRect().width;
      document.querySelector('[data-tab="Players"]').click();
      return {
        visible: getComputedStyle(document.getElementById('gameManagement')).display !== 'none',
        namespaces: Boolean(
          ManageApp.core && ManageApp.players && ManageApp.communications && ManageApp.media
        ),
        playerText: name && name.textContent,
        injectedElement: Boolean(name && name.querySelector('img')),
        playersActive: document.getElementById('Players').classList.contains('active'),
        locationOnly: !document.getElementById('court' + 'Number') &&
          !document.body.innerText.includes(['Court', 'Number'].join(' ')),
        additionalPlayers: document.getElementById('players').value,
        playersLabel: document.getElementById('playersLabel').textContent,
        personalityControlGone: !document.getElementById('personalityId'),
        intendedInviteeChoices: document.querySelectorAll(
          '#intendedInviteeList .roster-player-checkbox'
        ).length,
        // The disclaimer that used to sit under the title is gone; the invited list carries
        // the same honesty per person, where it can name who it applies to.
        inviteeExplainerGone: !document.querySelector('#intendedInviteesTitle + p'),
        inviteScoreboard: document.getElementById('inviteSummary')?.textContent,
        imageUpdateCopyGone: !document.querySelector('.court-images-intro'),
        manualPlayerSamplesRemoved:
          !document.getElementById('playerName').hasAttribute('placeholder') &&
          !document.getElementById('playerPhone').hasAttribute('placeholder'),
        imageChoiceWidth,
        noImageWidth
      };
    })()`);
    assert(manageReady.visible && manageReady.namespaces, 'management feature modules initialize');
    assert(manageReady.playersActive, 'management tab listeners work without inline handlers');
    assert(manageReady.locationOnly, 'management details use location without a separate court field');
    assert(
      manageReady.additionalPlayers === '5' &&
        manageReady.playersLabel.includes('Besides You'),
      'management shows five additional players for a six-player game with the host playing'
    );
    assert(
      manageReady.personalityControlGone &&
        // Two seeded roster players plus the out player, who joined the host's roster by
        // texting that they could not make it.
        manageReady.intendedInviteeChoices === 3 &&
        manageReady.inviteeExplainerGone &&
        manageReady.inviteScoreboard === 'Nobody has been invited yet.',
      'management offers no personality choice and offers the roster to invite without an explainer paragraph'
    );
    assert(manageReady.imageUpdateCopyGone,
      'court image section carries no explainer paragraph');
    assert(
      manageReady.manualPlayerSamplesRemoved,
      'manual player name and phone fields have no pre-populated sample text'
    );
    assert(
      manageReady.imageChoiceWidth === manageReady.noImageWidth &&
        manageReady.noImageWidth <= 110,
      `No Image is a compact choice matching the court image tiles ` +
        `(${manageReady.imageChoiceWidth}px/${manageReady.noImageWidth}px)`
    );
    assert(
      manageReady.playerText.startsWith('<img') && !manageReady.injectedElement,
      'HTML-like player names remain text in the live page'
    );

    const gameHeader = await desktop.evaluate(`(() => {
      const summary = document.getElementById('gameSummary');
      const tabs = document.querySelector('.tabs-container');
      return {
        visible: summary && !summary.hidden,
        outsideTabPanes: !summary?.closest('.tabcontent'),
        aboveTabs: Boolean(tabs && summary.compareDocumentPosition(tabs) &
          Node.DOCUMENT_POSITION_FOLLOWING),
        headline: document.getElementById('gameSummaryHeadline').textContent,
        meta: document.getElementById('gameSummaryMeta').textContent,
        playerLink: document.getElementById('playerLinkField')?.value,
        copyLinkLabel: document.getElementById('copyPlayerLinkOnly')?.textContent.trim()
      };
    })()`);
    assert(
      gameHeader.visible && gameHeader.outsideTabPanes && gameHeader.aboveTabs,
      'the game summary sits above the tabs so it shows on every tab'
    );
    assert(
      gameHeader.headline.includes('Oak Park Courts') &&
        /\d:\d\d (AM|PM)/.test(gameHeader.headline),
      `the summary names the game being managed (${gameHeader.headline})`
    );
    assert(
      /\d of \d in/.test(gameHeader.meta) &&
        (gameHeader.meta.includes('starts in') || gameHeader.meta.includes('Game has started')),
      `the summary counts the roster and the time until the game (${gameHeader.meta})`
    );
    assert(
      gameHeader.playerLink === `${local.baseUrl}/game.html?id=${fx.open.gameId}` &&
        gameHeader.copyLinkLabel === 'Copy Link',
      'the bare player link is shown with its own copy button'
    );

    const organizerSeat = await desktop.evaluate(`(() => {
      const toggle = document.getElementById('organizerPlaying');
      const before = {
        checked: toggle.checked,
        label: document.getElementById('playersLabel').textContent,
        // The stray timer that used to uncheck every box 200ms after load is gone, so the
        // default audience survives.
        recipientDefault: document.getElementById('sendToPlayers').checked
      };
      toggle.checked = false;
      toggle.dispatchEvent(new Event('change', { bubbles: true }));
      const afterLabel = document.getElementById('playersLabel').textContent;
      // Put it back: this game is photographed and asserted on elsewhere.
      toggle.checked = true;
      toggle.dispatchEvent(new Event('change', { bubbles: true }));
      return { before, afterLabel, restoredLabel: document.getElementById('playersLabel').textContent };
    })()`);
    assert(
      organizerSeat.before.checked &&
        organizerSeat.before.label === 'Players Needed (Besides You):',
      'the host can see and change whether they are playing in their own game'
    );
    assert(
      organizerSeat.afterLabel === 'Total Players Needed:' &&
        organizerSeat.restoredLabel === 'Players Needed (Besides You):',
      'the player-count label follows the playing toggle before anything is saved'
    );
    assert(
      organizerSeat.before.recipientDefault,
      'the confirmed-players recipient default survives page load'
    );

    const organizerRow = await desktop.evaluate(`(() => {
      const rows = [...document.querySelectorAll('#confirmedPlayers .player-item')];
      const organizer = rows.find(
        (row) => row.querySelector('.player-name')?.textContent.includes('(Organizer)')
      );
      const other = rows.find((row) => row !== organizer);
      return {
        found: Boolean(organizer),
        organizerActions: organizer
          ? organizer.querySelectorAll('.player-actions button').length
          : -1,
        organizerNote: organizer?.textContent.includes('You are hosting this game'),
        otherActions: other
          ? [...other.querySelectorAll('.player-actions button')].map((b) => b.textContent)
          : []
      };
    })()`);
    assert(
      organizerRow.found && organizerRow.organizerActions === 0 && organizerRow.organizerNote,
      'the organizer row offers no way to remove the host from their own game'
    );
    assert(
      organizerRow.otherActions.join('|') === 'To Waitlist|Remove',
      'every other confirmed player keeps the roster actions'
    );

    const inviteeTracking = await desktop.evaluate(`(async () => {
      const choices = [...document.querySelectorAll('#intendedInviteeList .roster-player-checkbox')];
      const outPlayer = choices.find((box) => box.dataset.phone === '5555550888');
      outPlayer.checked = true;
      outPlayer.dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('copyPlayerLink').click();
      await new Promise((resolve) => setTimeout(resolve, 700));
      const hostGame = await fetch(
        '/api/games/${fx.open.gameId}?token=${fx.open.hostToken}'
      ).then((response) => response.json());
      const publicGame = await fetch('/api/games/${fx.open.gameId}')
        .then((response) => response.json());
      const invitation = await fetch(
        '/api/games/${fx.open.gameId}/invitation-message',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: '${fx.open.hostToken}' })
        }
      ).then((response) => response.json());
      return {
        intended: hostGame.invitedPlayers?.length,
        clearedAfterCopy: document.querySelectorAll(
          '#intendedInviteeList .roster-player-checkbox:checked'
        ).length,
        publicLeak: Object.prototype.hasOwnProperty.call(publicGame, 'invitedPlayers'),
        invitationHasLink: invitation.message?.includes(
          '/game.html?id=${fx.open.gameId}'
        ),
        invitationHasDetails: invitation.message?.includes('Oak Park Courts') &&
          !invitation.message?.includes('do not reply to this text message')
      };
    })()`);
    assert(
      inviteeTracking.intended === 1 &&
        inviteeTracking.clearedAfterCopy === 0 &&
        !inviteeTracking.publicLeak &&
        inviteeTracking.invitationHasLink &&
        inviteeTracking.invitationHasDetails,
      'copying records who was ticked, privately, and server-built invitations keep every instruction'
    );

    const invitationSend = await desktop.evaluate(`(async () => {
      const before = document.getElementById('inviteSummary').textContent;
      const originalFetch = window.fetch.bind(window);
      let droppedInvitationResponse = false;
      window.fetch = async (url, options = {}) => {
        if (!droppedInvitationResponse && String(url).endsWith('/invitations') && options.method === 'POST') {
          droppedInvitationResponse = true;
          await originalFetch(url, options);
          throw new TypeError('Load failed');
        }
        return originalFetch(url, options);
      };
      const boxes = [...document.querySelectorAll('#intendedInviteeList .roster-player-checkbox')];
      boxes.forEach((box) => { box.checked = false; });
      // Roster Player Two has not joined this game, so they are a real invitee.
      const target = boxes.find((box) => box.dataset.phone === '${fx.FORM_PHONE}');
      target.checked = true;
      target.dispatchEvent(new Event('change', { bubbles: true }));
      const sendLabel = document.getElementById('textInvitations').textContent;
      document.getElementById('textInvitations').click();
      const confirmText = document.getElementById('confirmMessage').textContent;
      const confirmIsDanger = document.getElementById('confirmYes')
        .classList.contains('btn-danger');
      document.getElementById('confirmYes').click();
      await new Promise((resolve) => setTimeout(resolve, 1200));
      window.fetch = originalFetch;

      const hostGame = await fetch(
        '/api/games/${fx.open.gameId}?token=${fx.open.hostToken}'
      ).then((response) => response.json());
      const recorded = (hostGame.invitedPlayers || []).find(
        (person) => person.phone === '${fx.FORM_PHONE}'
      );
      return {
        before,
        confirmText,
        confirmIsDanger,
        sendLabel,
        status: document.getElementById('status').textContent,
        waiting: document.getElementById('inviteSummary').textContent,
        waitingNames: [...document.querySelectorAll('#invitedList .player-name')]
          .map((node) => node.textContent.trim()),
        chips: [...document.querySelectorAll('#invitedList .status-chip')]
          .map((node) => node.textContent.trim()),
        nudgeVisible: !document.getElementById('nudgeNonResponders').hidden,
        nudgeShown: getComputedStyle(
          document.getElementById('nudgeNonResponders')
        ).display !== 'none',
        recordedTextCount: recorded && recorded.textCount,
        recordedStatus: recorded && recorded.lastTextStatus,
        recordedAt: Boolean(recorded && recorded.lastTextedAt),
        recoveredDroppedResponse: droppedInvitationResponse
      };
    })()`);
    assert(
      invitationSend.before.includes('invited') &&
        invitationSend.sendLabel === 'Text The Invitation (1)' &&
        invitationSend.confirmText === 'Text the invitation to 1 person now?' &&
        !invitationSend.confirmIsDanger,
      `the button counts the selection and sending confirms without a danger colour ` +
      `(${invitationSend.sendLabel} / ${invitationSend.confirmText})`
    );
    assert(
      /Invitation texted to 1 person/.test(invitationSend.status) &&
        invitationSend.recoveredDroppedResponse &&
        invitationSend.recordedTextCount === 1 &&
        invitationSend.recordedStatus === 'sent' &&
        invitationSend.recordedAt,
      `a texted invitation is recorded and a dropped response is recovered without resending ` +
        `(${invitationSend.status})`
    );
    assert(
      invitationSend.waiting === '2 invited · 1 out · 1 no reply' &&
        invitationSend.waitingNames[0] === 'Roster Player Two' &&
        invitationSend.chips.join('|') === 'No Reply|OUT' &&
        invitationSend.nudgeVisible && invitationSend.nudgeShown,
      `the scoreboard counts everyone invited and chases the silent one ` +
      `(${invitationSend.waiting} / ${invitationSend.chips.join(',')})`
    );

    const rosterPickerReady = await desktop.evaluate(`(() => {
      document.querySelector('[data-collapsible="addPlayerSection"]').click();
      const choices = [...document.querySelectorAll('#rosterPlayerList .roster-player-checkbox')];
      const names = [...document.querySelectorAll('#rosterPlayerList .roster-player-name')]
        .map((node) => node.textContent.trim());
      choices.forEach((choice) => {
        choice.checked = true;
        choice.dispatchEvent(new Event('change', { bubbles: true }));
      });
      const button = document.getElementById('addRosterPlayersBtn');
      const result = {
        count: choices.length,
        names,
        buttonText: button.textContent,
        buttonEnabled: !button.disabled
      };
      button.click();
      return result;
    })()`);
    assert(
      rosterPickerReady.count === 2 &&
        rosterPickerReady.names.join('|') === 'Roster Player One|Roster Player Two',
      'management loads the host roster as safe multi-select choices'
    );
    assert(
      rosterPickerReady.buttonEnabled &&
        rosterPickerReady.buttonText === 'Add 2 Selected Players',
      'the roster action reflects the number of selected players'
    );
    await cdp.sleep(1000);
    const rosterAddResult = await desktop.evaluate(`(() => {
      const names = [
        ...document.querySelectorAll('#confirmedPlayers .player-name'),
        ...document.querySelectorAll('#waitlistPlayers .player-name')
      ].map((node) => node.textContent.trim());
      return {
        firstAdded: names.includes('Roster Player One'),
        secondAdded: names.includes('Roster Player Two'),
        status: document.getElementById('status').textContent,
        pickerEmpty: document.getElementById('rosterPickerStatus').textContent
      };
    })()`);
    assert(
      rosterAddResult.firstAdded && rosterAddResult.secondAdded,
      'multiple selected roster players are added through the management page'
    );
    assert(
      rosterAddResult.status === '2 roster players added successfully.' &&
        rosterAddResult.pickerEmpty === 'Everyone on your roster is already listed for this game.',
      'the roster picker reports success and filters players already in the game'
    );

    const invitationAnswered = await desktop.evaluate(`(() => ({
      waiting: document.getElementById('inviteSummary').textContent,
      rows: document.querySelectorAll('#invitedList .player-item').length,
      chips: [...document.querySelectorAll('#invitedList .status-chip')]
        .map((node) => node.textContent.trim()),
      nudgeHidden: document.getElementById('nudgeNonResponders').hidden,
      nudgeGone: getComputedStyle(
        document.getElementById('nudgeNonResponders')
      ).display === 'none'
    }))()`);
    assert(
      invitationAnswered.waiting === '2 invited · 1 waiting · 1 out · everyone replied' &&
        invitationAnswered.rows === 2 &&
        invitationAnswered.chips.join('|') === 'OUT|Waitlist' &&
        invitationAnswered.nudgeHidden && invitationAnswered.nudgeGone,
      `joining answers the invitation and the chase button really disappears ` +
      `(${invitationAnswered.waiting} / ${invitationAnswered.chips.join(',')})`
    );

    const recipientSelection = await desktop.evaluate(`(() => {
      const container = document.getElementById('playerCheckboxes');
      const boxes = [...container.querySelectorAll('.player-checkbox')];
      const groups = ['sendToAll', 'sendToPlayers', 'sendToWaitlist']
        .map((id) => document.getElementById(id));

      // A half-built recipient list must survive the roster poll that runs every refresh.
      groups.forEach((group) => { group.checked = false; group.indeterminate = false; });
      boxes[0].checked = true;
      const chosen = boxes[0].value;
      ManageApp.players.updatePlayerLists();
      const refreshed = [...container.querySelectorAll('.player-checkbox')];
      const kept = refreshed
        .filter((box) => box.checked)
        .map((box) => box.value);

      // Notification preferences are checkboxes too, and they used to be able to stand in for
      // "send to confirmed players" through the old fallback selectors.
      const preference = document.getElementById('notifyPlayerJoins');
      if (preference) preference.checked = true;
      refreshed.forEach((box) => { box.checked = false; });
      const strayRecipients = ManageApp.communications.getSelectedRecipients().length;

      return {
        rendered: boxes.length,
        kept: kept.join('|'),
        chosen,
        groupsStillOff: groups.every((group) => !group.checked),
        strayRecipients
      };
    })()`);
    assert(
      recipientSelection.rendered >= 2 &&
        recipientSelection.kept === recipientSelection.chosen &&
        recipientSelection.groupsStillOff,
      'a partial recipient selection survives a roster refresh'
    );
    assert(
      recipientSelection.strayRecipients === 0,
      'notification preference toggles never count as announcement recipients'
    );

    const outAudience = await desktop.evaluate(`(() => {
      const groups = ['sendToPlayers', 'sendToWaitlist', 'sendToOut'];
      groups.forEach((id) => {
        const group = document.getElementById(id);
        group.checked = id === 'sendToOut';
        group.dispatchEvent(new Event('change', { bubbles: true }));
      });
      const chosen = ManageApp.communications.getSelectedRecipients();
      return {
        label: document.querySelector('label[for="sendToOut"]')?.textContent.trim(),
        rows: [...document.querySelectorAll('#playerCheckboxes .player-checkbox')]
          .map((box) => box.dataset.type),
        chosen: chosen.map((person) => person.type + ':' + person.name),
        allPartial: document.getElementById('sendToAll').indeterminate
      };
    })()`);
    assert(
      outAudience.label === 'Players Who Are Out' && outAudience.rows.includes('out'),
      'the out list is offered as its own recipient group and row'
    );
    assert(
      outAudience.chosen.join('|') === 'out:Out Player' && outAudience.allPartial,
      `choosing only the out list selects only those players (${outAudience.chosen.join('|')})`
    );

    await desktop.evaluate(`(() => {
      document.getElementById('playerName').value = 'Manual Waitlist Player';
      document.getElementById('addToWaitlist').checked = true;
      document.getElementById('addPlayerForm').requestSubmit();
    })()`);
    await cdp.sleep(700);
    const manualWaitlistAdded = await desktop.evaluate(`(() =>
      [...document.querySelectorAll('#waitlistPlayers .player-name')]
        .some((node) => node.textContent.trim() === 'Manual Waitlist Player')
    )()`);
    assert(
      manualWaitlistAdded,
      'the manual Waitlist choice sends the destination expected by the server'
    );

    const rosterTimestamps = await desktop.evaluate(`(() => {
      const textOf = (selector) => [...document.querySelectorAll(selector)]
        .map((node) => node.textContent);
      return {
        confirmed: textOf('#confirmedPlayers .player-item'),
        waitlist: textOf('#waitlistPlayers .player-item')
      };
    })()`);
    assert(
      rosterTimestamps.confirmed.some((row) => /Signed up .* ago|Signed up just now/.test(row)),
      'confirmed players show when they signed up'
    );
    assert(
      rosterTimestamps.waitlist.some(
        (row) => /Waiting \d|Joined the waitlist just now/.test(row)
      ),
      'waitlist entries show how long they have been waiting'
    );

    const quickMessage = await desktop.evaluate(`(async () => {
      document.querySelector('[data-tab="Communication"]').click();
      document.getElementById('sendReminder').click();
      const modalText = document.getElementById('confirmMessage').textContent;
      const modalOpen = getComputedStyle(document.getElementById('confirmModal')).display !== 'none';

      // Nothing leaves until the host confirms the exact wording.
      document.getElementById('confirmYes').click();
      await new Promise((resolve) => setTimeout(resolve, 900));
      return {
        modalOpen,
        modalText,
        status: document.getElementById('status').textContent,
        modalClosed: getComputedStyle(document.getElementById('confirmModal')).display === 'none'
      };
    })()`);
    assert(
      quickMessage.modalOpen &&
        quickMessage.modalText.includes('Reminder: Your pickleball game is on') &&
        quickMessage.modalText.includes('confirmed player'),
      'the game reminder shows its exact wording and audience before sending'
    );
    assert(
      quickMessage.modalClosed && /Sent to \d+ player/.test(quickMessage.status),
      `the confirmed quick message is actually sent (${quickMessage.status})`
    );

    const deliveryLog = await desktop.evaluate(`(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
      const rows = [...document.querySelectorAll('.delivery-row')];
      const raw = await fetch(
        '/api/games/${fx.open.gameId}/sms-events?token=${fx.open.hostToken}'
      ).then((response) => response.json());
      const unauthorized = await fetch(
        '/api/games/${fx.open.gameId}/sms-events?token=not-the-host'
      );
      return {
        status: document.getElementById('deliveryLogStatus').textContent,
        rowCount: rows.length,
        firstRow: rows[0] && rows[0].textContent,
        namedEveryone: raw.events.every((event) => event.name && !/^[0-9a-f]{64}$/.test(event.name)),
        namesAPlayer: raw.events.some((event) => event.name === 'Roster Player One'),
        showsTheFailure: raw.events.some(
          (event) => event.status === 'failed' && event.attempts === 3 &&
            event.event === 'Upcoming Game Reminder'
        ),
        // The failure reason must be readable in the row itself - a tooltip does not
        // exist on a phone, where hosts actually read this log.
        showsTheReason: [...document.querySelectorAll('.delivery-row.failed .delivery-error')]
          .some((element) => element.textContent === 'Carrier rejected the message'),
        leaksHashes: JSON.stringify(raw).includes('recipientHash'),
        unauthorizedStatus: unauthorized.status,
        readOnly: !document.querySelector('.delivery-row button, .delivery-row input')
      };
    })()`);
    assert(
      deliveryLog.rowCount > 0 && deliveryLog.namedEveryone && deliveryLog.namesAPlayer,
      `the delivery log lists sends by name rather than by number (${deliveryLog.status})`
    );
    assert(
      deliveryLog.showsTheFailure && deliveryLog.readOnly && !deliveryLog.leaksHashes,
      'a failed text is shown with its attempts, read-only, and no recipient hashes'
    );
    assert(
      deliveryLog.showsTheReason,
      'a failed text displays the provider reason in the row, not only a tooltip'
    );
    assert(
      deliveryLog.unauthorizedStatus === 403,
      'the delivery log needs the host token'
    );

    const activeDeleteResponse = await fetch(
      `${local.baseUrl}/api/games/${fx.full.gameId}/permanent`,
      {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: fx.full.hostToken })
      }
    );
    assert(
      activeDeleteResponse.status === 400,
      'an active upcoming game remains protected from permanent deletion'
    );

    const cancelResponse = await fetch(
      `${local.baseUrl}/api/games/${fx.approval.gameId}`,
      {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: fx.approval.hostToken,
          reason: 'Browser smoke cancellation'
        })
      }
    );
    assert(cancelResponse.ok, 'future fixture can be cancelled for My Games coverage');

    await desktop.evaluate(`(() => {
      localStorage.setItem('hostPhone', '${fx.HOST_PHONE}');
      localStorage.setItem('hostVerificationToken', '${hostSession.token}');
    })()`);
    await desktop.goto(`${local.baseUrl}/my-games.html`);
    await cdp.sleep(500);
    const myGamesGrouping = await desktop.evaluate(`(() => {
      const createGameButton = getComputedStyle(document.querySelector('.create-game-btn'));
      const nativeButton = getComputedStyle(document.querySelector('#upcomingList button'));
      return {
        cancelledInUpcoming: document.querySelectorAll('#upcomingList .game-item.cancelled').length,
        cancelledInPast: document.querySelectorAll('#pastList .game-item.cancelled').length,
        cancelledPastLocation: document.querySelector('#pastList .game-item.cancelled .game-title')
          ?.textContent.trim(),
        cancelledHasDelete: Boolean(
          document.querySelector('#pastList .game-item.cancelled [data-delete]')
        ),
        buttonAlignment: {
          linkDisplay: createGameButton.display,
          linkAlign: createGameButton.alignItems,
          linkJustify: createGameButton.justifyContent,
          nativeDisplay: nativeButton.display,
          nativeAlign: nativeButton.alignItems,
          nativeJustify: nativeButton.justifyContent
        }
      };
    })()`);
    assert(
      ['flex', 'inline-flex'].includes(myGamesGrouping.buttonAlignment.linkDisplay) &&
        myGamesGrouping.buttonAlignment.linkAlign === 'center' &&
        myGamesGrouping.buttonAlignment.linkJustify === 'center' &&
        ['flex', 'inline-flex'].includes(myGamesGrouping.buttonAlignment.nativeDisplay) &&
        myGamesGrouping.buttonAlignment.nativeAlign === 'center' &&
        myGamesGrouping.buttonAlignment.nativeJustify === 'center',
      'native and link-style button labels are centered in both directions'
    );
    assert(
      myGamesGrouping.cancelledInUpcoming === 0 &&
        myGamesGrouping.cancelledInPast === 1 &&
        myGamesGrouping.cancelledPastLocation === 'Riverside Athletic Club',
      'a cancelled upcoming game moves from Upcoming to Past Games'
    );
    assert(
      myGamesGrouping.cancelledHasDelete,
      'a cancelled upcoming game offers immediate permanent deletion'
    );

    const repeatLink = await desktop.evaluate(`(() => {
      const card = document.querySelector('#pastList .game-item.cancelled');
      const link = [...card.querySelectorAll('a.btn')]
        .find((anchor) => anchor.textContent.trim() === 'Run It Again');
      return {
        href: link && link.getAttribute('href'),
        offeredOnUpcoming: [...document.querySelectorAll('#upcomingList a.btn')]
          .some((anchor) => anchor.textContent.trim() === 'Run It Again')
      };
    })()`);
    assert(
      repeatLink.href && repeatLink.href.startsWith('/create.html?repeat=') &&
        !repeatLink.offeredOnUpcoming,
      'past games offer Run It Again and upcoming games do not'
    );

    await desktop.goto(`${local.baseUrl}${repeatLink.href}`);
    await cdp.sleep(1200);
    const repeated = await desktop.evaluate(`(async () => {
      // page-utils.js is a module now rather than a global the create page happened to have
      // loaded, so the expectation is imported the same way the page imports it.
      const PageUtils = await import('/js/page-utils.js');
      const nextWeek = PageUtils.nextWeeklyDate('${fx.date}');
      return {
        notice: document.getElementById('repeatNotice').textContent,
        noticeVisible: !document.getElementById('repeatNotice').hidden,
        location: document.getElementById('location').value,
        date: document.getElementById('date').value,
        expectedDate: nextWeek,
        time: document.getElementById('time').value,
        duration: document.getElementById('duration').value,
        players: document.getElementById('players').value,
        organizerPlaying: document.getElementById('organizerPlaying').checked,
        message: document.getElementById('message').value,
        mode: document.querySelector('input[name="registrationMode"]:checked').value,
        modeHighlighted: document.querySelector('.mode-option[data-radio-id="waitlistMode"]')
          .classList.contains('checked'),
        joinsOn: document.getElementById('notifyPlayerJoins').checked,
        joinsHighlighted: document.querySelector('[data-checkbox-id="notifyPlayerJoins"]')
          .classList.contains('checked'),
        repeatedGameCreated: JSON.parse(localStorage.getItem('myGames') || '[]')
          .filter((stored) => stored.location === 'Riverside Athletic Club').length,
        today: new Date().toISOString().slice(0, 10)
      };
    })()`);
    assert(
      repeated.location === 'Riverside Athletic Club' && repeated.time === '09:30' &&
        repeated.duration === '120' && repeated.players === '3' && repeated.organizerPlaying &&
        repeated.message.includes('3.5+ level'),
      `Run It Again refills the court, time, length and player count (${repeated.location})`
    );
    assert(
      repeated.mode === 'waitlist' && repeated.modeHighlighted &&
        repeated.joinsOn && repeated.joinsHighlighted,
      'the registration mode and notification toggles come back with their visual state'
    );
    assert(
      repeated.date === repeated.expectedDate && repeated.date >= repeated.today,
      `the repeated game is never dated in the past (${repeated.date})`
    );
    assert(
      repeated.noticeVisible && repeated.notice.includes('Riverside Athletic Club') &&
        repeated.repeatedGameCreated === 0,
      'the repeat is a filled-in form, not a game created behind the host'
    );

    await desktop.goto(`${local.baseUrl}/my-games.html`);
    await cdp.sleep(700);

    const deletePanelOpened = await desktop.evaluate(`(() => {
      const card = document.querySelector('#pastList .game-item.cancelled');
      card.querySelector('[data-delete]').click();
      const panel = card.querySelector('.delete-panel');
      const opened = getComputedStyle(panel).display !== 'none';
      card.querySelector('[data-delete-confirm]').click();
      return opened;
    })()`);
    assert(deletePanelOpened, 'cancelled-game deletion still requires confirmation');
    await cdp.sleep(500);
    const cancelledDeleteResult = await desktop.evaluate(`(() => ({
      cardRemoved: !document.querySelector('#pastList .game-item.cancelled'),
      successMessage: document.getElementById('status').textContent
    }))()`);
    const deletedGameResponse = await fetch(
      `${local.baseUrl}/api/games/${fx.approval.gameId}`
    );
    assert(
      cancelledDeleteResult.cardRemoved &&
        cancelledDeleteResult.successMessage === 'Game deleted.' &&
        deletedGameResponse.status === 404,
      'a host can permanently delete a cancelled upcoming game immediately'
    );

    await desktop.goto(`${local.baseUrl}/dev.html`);
    const devPassword = JSON.stringify(server.DEV_PASSWORD);
    const devLogin = await desktop.evaluate(`(async () => {
      const res = await fetch('/api/dev/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: ${devPassword} })
      });
      if (res.ok) {
        DevDashboard.showApp();
        document.querySelector('[data-tab="slogans"]').click();
      }
      return res.ok;
    })()`);
    await cdp.sleep(500);
    const sloganEditor = await desktop.evaluate(`(() => ({
      slogans: document.querySelectorAll('#sloganList .slogan-entry').length,
      names: document.querySelectorAll('#sloganNameList .name-chip').length,
      sloganForm: Boolean(document.getElementById('sloganForm')),
      nameForm: Boolean(document.getElementById('sloganNameForm')),
      editButtons: document.querySelectorAll('[data-action="edit-slogan"]').length
    }))()`);
    assert(
      devLogin &&
        sloganEditor.slogans > 0 &&
        sloganEditor.names > 0 &&
        sloganEditor.sloganForm &&
        sloganEditor.nameForm &&
        sloganEditor.editButtons === sloganEditor.slogans,
      'developer area can manage the slogan and name rotations'
    );

    const messageRandomizer = await desktop.evaluate(`(async () => {
      document.querySelector('[data-tab="message-randomizer"]').click();
      await new Promise((resolve) => setTimeout(resolve, 650));
      const inventoryResponse = await fetch(
        '/api/dev/randomizer-messages?personalityId=realist'
      );
      const inventory = await inventoryResponse.json();
      document.querySelector(
        '#randomizerSurfaceRows tr[data-surface-id="site-slogan"] [data-action="surface-preview"]'
      ).click();
      await new Promise((resolve) => setTimeout(resolve, 250));
      const previewPanel = document.getElementById('randomizerPreviewPanel');
      const previewRect = previewPanel.getBoundingClientRect();
      const randomizerSections = [
        ...document.querySelectorAll('#tab-message-randomizer [data-randomizer-section]')
      ];
      const promptSections = [
        ...document.querySelectorAll('#randomizerPromptParagraphs textarea')
      ].map((textarea) => textarea.value);
      document.querySelector('[data-share-paragraph="8"]').checked = true;
      document.getElementById('randomizerSavePrompt').click();
      for (let attempt = 0; attempt < 30; attempt++) {
        const status = document.getElementById('randomizerPromptStatus').textContent;
        if (status.includes('saved for all message categories') ||
            (!status.includes('Saving') && status.trim())) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const savedPromptData = await fetch('/api/dev/message-randomizer')
        .then((response) => response.json());
      const savedPromptSections = savedPromptData.personalities[0].surfaces.map(
        (surface) => surface.codexPrompt.sections
      );
      const promptSavedStatus = document.getElementById('randomizerPromptStatus')
        .textContent.includes('also saved for all message categories');
      const promptSurfaceSelect = document.getElementById('randomizerPromptSurface');
      promptSurfaceSelect.value = 'all';
      promptSurfaceSelect.dispatchEvent(new Event('change', { bubbles: true }));
      const allCategoryScope =
        document.getElementById('randomizerCopyPrompt').disabled &&
        document.getElementById('randomizerPromptScopeHelp').textContent.includes(
          'same for every category'
        ) &&
        document.querySelectorAll('#randomizerPromptParagraphs textarea').length === 9;
      promptSurfaceSelect.value = 'site-slogan';
      promptSurfaceSelect.dispatchEvent(new Event('change', { bubbles: true }));
      return {
        visible: !document.getElementById('tab-message-randomizer').classList.contains('hidden'),
        collapsibleSections: randomizerSections.length,
        onlyPreviewExpanded:
          randomizerSections.filter((section) => section.open).length === 1 &&
          previewPanel.open,
        personality: document.getElementById('randomizerPersonality').value,
        surfaces: document.querySelectorAll('#randomizerSurfaceRows tr').length,
        messages: inventory.messages.length,
        slogans: inventory.messages.filter(
          (message) => message.surfaceId === 'site-slogan' &&
            message.locked && message.vetted
        ).length,
        youreIn: inventory.messages.filter(
          (message) => message.surfaceId === 'youre-in' &&
            message.locked && message.vetted
        ).length,
        favoriteLabels: document.getElementById('randomizerMessageList')
          .textContent.includes('Locked Favorite') &&
          document.getElementById('randomizerMessageList').textContent.includes('Vetted'),
        reusablePrompt:
          document.getElementById('randomizerReusablePrompt').value.includes(
            'Generate 50 distinct candidate messages'
          ) &&
          document.getElementById('randomizerReusablePrompt').value.includes(
            'Do not change the app until I explicitly say'
          ) &&
          document.getElementById('randomizerReusablePrompt').value.includes('Paragraph 9:') &&
          document.getElementById('randomizerPromptSurface').options.length === 22 &&
          document.querySelectorAll('#randomizerPromptParagraphs textarea').length === 9 &&
          document.querySelectorAll('[data-share-paragraph]').length === 9 &&
          !document.querySelector('#randomizerPromptParagraphs textarea').readOnly &&
          Boolean(document.getElementById('randomizerCopyPrompt')) &&
          Boolean(document.getElementById('randomizerSavePrompt')),
        savedPrompts:
          promptSavedStatus &&
          savedPromptSections.length === 21 &&
          savedPromptSections.every((sections) => sections[8] === promptSections[8]),
        allCategoryScope,
        targetPlayers: document.getElementById('randomizerRulePlayer').options.length,
        preview: document.querySelector('#randomizerPreviewOutput .randomizer-preview')
          ?.textContent.trim(),
        previewSurface: document.getElementById('randomizerPreviewSurface').value,
        previewPanelVisible: previewRect.top >= 0 && previewRect.top < window.innerHeight,
        externalScript: [...document.scripts].some(
          (script) => script.src.endsWith('/js/message-randomizer-admin.js')
        )
      };
    })()`);
    assert(
      messageRandomizer.visible &&
        messageRandomizer.collapsibleSections === 7 &&
        messageRandomizer.onlyPreviewExpanded &&
        messageRandomizer.personality === 'realist' &&
        messageRandomizer.surfaces === 21 &&
        messageRandomizer.messages >= 41 &&
        // At least the bundled seed counts; one extra row remains in databases that
        // predate the DUPR line removal until it is archived through the dev editors.
        messageRandomizer.slogans >= 18 &&
        messageRandomizer.youreIn >= 21 &&
        messageRandomizer.favoriteLabels &&
        messageRandomizer.reusablePrompt &&
        messageRandomizer.savedPrompts &&
        messageRandomizer.allCategoryScope &&
        messageRandomizer.targetPlayers > 1 &&
        messageRandomizer.preview &&
        messageRandomizer.preview !== 'Resolving stored inventory…' &&
        messageRandomizer.previewSurface === 'site-slogan' &&
        messageRandomizer.previewPanelVisible &&
        messageRandomizer.externalScript,
      'developer Message Randomizer shows vetted favorites, targeting, and a working surface preview'
    );

    const imageInventory = await desktop.evaluate(`(async () => {
      document.querySelector('[data-tab="images"]').click();
      await new Promise((resolve) => setTimeout(resolve, 350));
      const developerUploadResponse = await fetch(
        '/api/dev/courts/${encodeURIComponent('Oak Park Courts')}/image',
        {
          method: 'POST',
          headers: { 'Content-Type': 'image/png' },
          body: new Uint8Array(${JSON.stringify([...PNG_1PX])})
        }
      );
      const developerUpload = await developerUploadResponse.json();
      // Redraw the tab so the upload just made shows up. This used to call the page's own
      // global loadImages(); the dashboard is modules now, so it goes through the namespace.
      await DevDashboard.loadImages();
      const apiResponse = await fetch('/api/dev/images');
      const apiData = await apiResponse.json();
      const wantedIds = ${JSON.stringify([
        firstCourtImage.imageId,
        secondCourtImage.imageId,
        firstGamePhoto.id,
        secondGamePhoto.id
      ])}.concat(developerUpload.imageId);
      const wanted = apiData.images.filter((image) => wantedIds.includes(image.id));
      const cards = wantedIds.map((id) =>
        document.querySelector('[data-image-id="' + id + '"]')
      );
      return {
        responseOk: apiResponse.ok && developerUploadResponse.ok,
        developerImageId: developerUpload.imageId,
        developerUploader: wanted.find((image) => image.id === developerUpload.imageId)?.uploaderName,
        tabLabel: document.querySelector('[data-tab="images"]').textContent.trim(),
        visible: !document.getElementById('tab-images').classList.contains('hidden'),
        sourceTitle: document.getElementById('imageSourceTitle').textContent.trim(),
        wanted: wanted.length,
        courtImages: wanted.filter((image) => image.type === 'court').length,
        gamePhotos: wanted.filter((image) => image.type === 'game').length,
        uploaderNames: [...new Set(wanted.map((image) => image.uploaderName))],
        cards: cards.filter(Boolean).length,
        cardUploaders: cards.map((card) =>
          [...(card?.querySelectorAll('.image-card-details dd') || [])][0]?.textContent.trim()
        ),
        deleteLabels: cards.map((card) =>
          card?.querySelector('[data-action="delete-image"]')?.textContent.trim()
        )
      };
    })()`);
    assert(
      imageInventory.responseOk &&
        imageInventory.tabLabel === 'Images' &&
        imageInventory.visible &&
        imageInventory.sourceTitle === 'Showing Local Test Images' &&
        imageInventory.wanted === 5 &&
        imageInventory.courtImages === 3 &&
        imageInventory.gamePhotos === 2 &&
        imageInventory.uploaderNames.includes('Scott H.') &&
        imageInventory.uploaderNames.includes('Developer Area') &&
        imageInventory.developerUploader === 'Developer Area' &&
        imageInventory.cards === 5 &&
        imageInventory.deleteLabels.every((label) => label === 'Delete Image'),
      'developer Images tab shows every image type, uploader names, and delete controls'
    );

    const linkedCourtImageDelete = await desktop.evaluate(`(async () => {
      const originalConfirm = window.confirm;
      window.confirm = () => true;
      document.querySelector(
        '[data-image-id="${imageInventory.developerImageId}"] [data-action="delete-image"]'
      ).click();
      await new Promise((resolve) => setTimeout(resolve, 500));
      window.confirm = originalConfirm;
      return !document.querySelector('[data-image-id="${imageInventory.developerImageId}"]');
    })()`);
    const [deletedCourtLibraryImage, deletedLegacyCourtImage, libraryAfterDeveloperDelete] =
      await Promise.all([
        fetch(`${local.baseUrl}/api/court-images/${imageInventory.developerImageId}`),
        fetch(`${local.baseUrl}/api/courts/${encodeURIComponent('Oak Park Courts')}/image`),
        fetch(`${local.baseUrl}/api/courts/${encodeURIComponent('Oak Park Courts')}/library`)
          .then((response) => response.json())
      ]);
    assert(
      linkedCourtImageDelete &&
        deletedCourtLibraryImage.status === 404 &&
        deletedLegacyCourtImage.status === 404 &&
        !libraryAfterDeveloperDelete.images.some(
          (image) => image.id === imageInventory.developerImageId
        ),
      'deleting a developer court image removes its library and legacy copies together'
    );

    const developerImageDelete = await desktop.evaluate(`(async () => {
      const originalConfirm = window.confirm;
      window.confirm = () => true;
      document.querySelector(
        '[data-image-id="${firstGamePhoto.id}"] [data-action="delete-image"]'
      ).click();
      await new Promise((resolve) => setTimeout(resolve, 500));
      window.confirm = originalConfirm;
      return {
        removed: !document.querySelector('[data-image-id="${firstGamePhoto.id}"]'),
        remainingGamePhoto: Boolean(
          document.querySelector('[data-image-id="${secondGamePhoto.id}"]')
        )
      };
    })()`);
    const deletedPhotoResponse = await fetch(`${local.baseUrl}${firstGamePhoto.url}`);
    assert(
      developerImageDelete.removed &&
        developerImageDelete.remainingGamePhoto &&
        deletedPhotoResponse.status === 404,
      'a developer can permanently delete any uploaded image from the Images tab'
    );
    await desktop.evaluate(
      `document.querySelector('[data-tab="slogans"]').click()`
    );
    await cdp.sleep(250);
    const sloganEditControls = await desktop.evaluate(`(() => {
      const original = document.querySelector('#sloganList .copy').textContent;
      document.querySelector('[data-action="edit-slogan"]').click();
      const form = document.querySelector('.slogan-edit-form');
      const input = form.querySelector('input');
      const result = {
        value: input.value,
        focused: document.activeElement === input,
        save: form.querySelector('button[type="submit"]').textContent.trim(),
        cancel: form.querySelector('[data-action="cancel-edit-slogan"]').textContent.trim()
      };
      form.querySelector('[data-action="cancel-edit-slogan"]').click();
      result.cancelled = document.querySelector('#sloganList .copy').textContent === original;
      return result;
    })()`);
    assert(
      sloganEditControls.value &&
        sloganEditControls.focused &&
        sloganEditControls.save === 'Save' &&
        sloganEditControls.cancel === 'Cancel' &&
        sloganEditControls.cancelled,
      'developer area opens and cancels inline slogan editing'
    );

    const rosterDirectory = await desktop.evaluate(`(async () => {
      document.querySelector('[data-tab="rosters"]').click();
      await new Promise((resolve) => setTimeout(resolve, 350));
      const player = document.querySelector(
        '[data-player-phone="${fx.JOIN_PHONE}"]'
      );
      return {
        visible: !document.getElementById('tab-rosters').classList.contains('hidden'),
        hosts: document.querySelectorAll('#hostRosterList .host-roster').length,
        players: document.querySelectorAll('#masterRosterList .master-player').length,
        playerFound: Boolean(player),
        editButton: player?.querySelector('[data-roster-action="edit"]')?.textContent.trim(),
        deleteButton: player?.querySelector('[data-roster-action="delete"]')?.textContent.trim(),
        phone: player?.querySelector('.roster-person-phone')?.textContent.trim(),
        hostRoster: player?.querySelector('.roster-person-meta')?.textContent.trim(),
        sourceTitle: document.getElementById('rosterSourceTitle').textContent.trim(),
        sourceSwitchHidden: document.getElementById('rosterSourceToggle').classList.contains('hidden')
      };
    })()`);
    assert(
      rosterDirectory.visible &&
        rosterDirectory.hosts > 0 &&
        rosterDirectory.players > 0 &&
        rosterDirectory.playerFound &&
        rosterDirectory.editButton === 'Edit' &&
        rosterDirectory.deleteButton === 'Delete' &&
        rosterDirectory.phone === '(555) 555-0777' &&
        rosterDirectory.hostRoster === 'Host Roster: Scott H.' &&
        rosterDirectory.sourceTitle === 'Showing Local Test Data' &&
        rosterDirectory.sourceSwitchHidden,
      'developer area identifies each player’s host roster while automated local servers stay locked away from production'
    );

    // Setting a brand new host up and handing them a starter roster, which is the whole
    // reason the developer area can create a host at all.
    const starterHost = await desktop.evaluate(`(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const form = document.getElementById('addHostForm');
      form.elements.name.value = 'Smoke Starter Host';
      form.elements.phone.value = '(555) 555-0991';
      form.requestSubmit();
      await wait(500);

      const card = document.querySelector('.host-roster[data-host-phone="5555550991"]');
      const created = {
        listed: Boolean(card),
        name: card?.querySelector('.roster-person-name')?.textContent.trim(),
        startsEmpty: card?.querySelector('.host-roster-players .muted')?.textContent.trim(),
        opened: card?.open === true
      };
      if (!card) return created;

      card.querySelector('[data-host-action="pick"]').click();
      await wait(120);
      const picker = card.querySelector('[data-picker]');
      const option = picker.querySelector('.host-picker-option[data-player-phone="${fx.JOIN_PHONE}"]');
      created.pickerOpened = !picker.classList.contains('hidden');
      created.offersPlayer = Boolean(option);
      // The host themselves is never on offer.
      created.excludesHost = !picker.querySelector('.host-picker-option[data-player-phone="5555550991"]');

      option.querySelector('input').checked = true;
      option.querySelector('input').dispatchEvent(new Event('change', { bubbles: true }));
      const addButton = picker.querySelector('[data-host-action="add-players"]');
      created.addLabel = addButton.textContent.trim();
      addButton.click();
      await wait(600);

      const seeded = document.querySelector('.host-roster[data-host-phone="5555550991"]');
      const row = seeded?.querySelector('.host-roster-player[data-player-phone="${fx.JOIN_PHONE}"]');
      created.stillOpen = seeded?.open === true;
      created.seededPlayer = Boolean(row);
      created.removeLabel = row?.querySelector('[data-host-action="remove-player"]')?.textContent.trim();
      created.result = seeded?.querySelector('.host-roster-status')?.textContent.trim();

      row.querySelector('[data-host-action="remove-player"]').click();
      await wait(600);
      const afterRemoval = document.querySelector('.host-roster[data-host-phone="5555550991"]');
      created.removed = !afterRemoval?.querySelector(
        '.host-roster-player[data-player-phone="${fx.JOIN_PHONE}"]'
      );

      // Leave the local database as this smoke found it.
      await fetch('/api/dev/hosts/5555550991?source=local', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmPhone: '5555550991' })
      });
      await DevDashboard.loadRosters('local');
      created.cleanedUp = !document.querySelector('.host-roster[data-host-phone="5555550991"]');
      return created;
    })()`);
    assert(
      starterHost.listed &&
        starterHost.name === 'Smoke Starter Host' &&
        starterHost.startsEmpty === 'No players on this roster.' &&
        starterHost.opened &&
        starterHost.pickerOpened &&
        starterHost.offersPlayer &&
        starterHost.excludesHost &&
        starterHost.addLabel === 'Add 1 Selected Player' &&
        starterHost.seededPlayer &&
        starterHost.stillOpen &&
        starterHost.removeLabel === 'Remove' &&
        starterHost.result === '1 added.' &&
        starterHost.removed &&
        starterHost.cleanedUp,
      'a new host can be created and given a starter roster from existing players'
    );

    const rosterEdit = await desktop.evaluate(`(async () => {
      const player = document.querySelector('[data-player-phone="${fx.JOIN_PHONE}"]');
      player.querySelector('[data-roster-action="edit"]').click();
      const form = player.querySelector('.player-edit-form');
      form.elements.name.value = 'Sam Rivera Edited';
      form.requestSubmit();
      await new Promise((resolve) => setTimeout(resolve, 450));
      const updated = document.querySelector('[data-player-phone="${fx.JOIN_PHONE}"]');
      return {
        masterName: updated?.querySelector('.roster-person-name')?.textContent.trim(),
        hostHasName: document.getElementById('hostRosterList').textContent.includes('Sam Rivera Edited')
      };
    })()`);
    assert(
      rosterEdit.masterName === 'Sam Rivera Edited' && rosterEdit.hostHasName,
      'editing a master player updates the master list and host roster'
    );

    const rosterDelete = await desktop.evaluate(`(async () => {
      const player = document.querySelector('[data-player-phone="${fx.JOIN_PHONE}"]');
      player.querySelector('[data-roster-action="delete"]').click();
      const warning = player.querySelector('.player-delete-confirm');
      const warned = !warning.classList.contains('hidden') &&
        warning.textContent.includes('every host roster and every game roster');
      warning.querySelector('[data-roster-action="confirm-delete"]').click();
      await new Promise((resolve) => setTimeout(resolve, 450));
      return {
        warned,
        removed: !document.querySelector('[data-player-phone="${fx.JOIN_PHONE}"]')
      };
    })()`);
    assert(
      rosterDelete.warned && rosterDelete.removed,
      'deleting a master player requires a specific warning and removes the player everywhere'
    );

    const styleCommandCenter = await desktop.evaluate(`(() => {
      document.querySelector('[data-tab="style-command-center"]').click();
      const rootStyles = getComputedStyle(document.documentElement);
      const activePanel = document.getElementById('tab-style-command-center');
      const compactButton = activePanel.querySelector('.style-button-compact');
      const standardButton = activePanel.querySelector(
        '.style-button:not(.style-button-compact):not(.style-button-large)'
      );
      const largeButton = activePanel.querySelector('.style-button-large');
      return {
        visible: !activePanel.classList.contains('hidden'),
        active: document.querySelector('[data-tab="style-command-center"]').classList.contains('active'),
        brand: rootStyles.getPropertyValue('--brand').trim(),
        ink: rootStyles.getPropertyValue('--ink').trim(),
        canvas: rootStyles.getPropertyValue('--canvas').trim(),
        surface: rootStyles.getPropertyValue('--surface').trim(),
        warning: rootStyles.getPropertyValue('--warning').trim(),
        danger: rootStyles.getPropertyValue('--danger').trim(),
        tokens: activePanel.querySelectorAll('.style-token').length,
        rules: activePanel.querySelectorAll('.style-rule').length,
        statuses: activePanel.querySelectorAll('.style-status').length,
        compactHeight: getComputedStyle(compactButton).minHeight,
        standardHeight: getComputedStyle(standardButton).minHeight,
        largeHeight: getComputedStyle(largeButton).minHeight,
        invalidField: activePanel.querySelector('[aria-invalid="true"]') !== null
      };
    })()`);
    assert(
      styleCommandCenter.visible &&
        styleCommandCenter.active &&
        styleCommandCenter.brand.toLowerCase() === '#166534' &&
        styleCommandCenter.ink.toLowerCase() === '#172033' &&
        styleCommandCenter.canvas.toLowerCase() === '#f4f6f3' &&
        styleCommandCenter.surface.toLowerCase() === '#ffffff' &&
        styleCommandCenter.warning.toLowerCase() === '#a85d00' &&
        styleCommandCenter.danger.toLowerCase() === '#b42318' &&
        styleCommandCenter.tokens === 6 &&
        styleCommandCenter.rules === 4 &&
        styleCommandCenter.statuses === 3 &&
        styleCommandCenter.compactHeight === '36px' &&
        styleCommandCenter.standardHeight === '44px' &&
        styleCommandCenter.largeHeight === '52px' &&
        styleCommandCenter.invalidField,
      'developer area shows the Court Classic palette and every selected component rule'
    );

    const rulesTab = await desktop.evaluate(`(() => {
      document.querySelector('[data-tab="rules"]').click();
      const activePanel = document.getElementById('tab-rules');
      const rules = [...activePanel.querySelectorAll('.build-rule')];
      return {
        visible: !activePanel.classList.contains('hidden'),
        active: document.querySelector('[data-tab="rules"]').classList.contains('active'),
        sections: activePanel.querySelectorAll('.rule-section').length,
        rules: rules.length,
        firstRule: rules[0]?.querySelector('strong')?.textContent.trim(),
        lastRule: rules.at(-1)?.querySelector('strong')?.textContent.trim()
      };
    })()`);
    assert(
      rulesTab.visible &&
        rulesTab.active &&
        rulesTab.sections === 6 &&
        rulesTab.rules === 41 &&
        rulesTab.firstRule === 'Prove Every Change As A User' &&
        rulesTab.lastRule === 'Trust Image Bytes, Not File Claims',
      'developer area lists every current app-building rule in the Rules tab'
    );

    const vibeCoder101 = await desktop.evaluate(`(() => {
      document.querySelector('[data-tab="vibe-coder-101"]').click();
      const activePanel = document.getElementById('tab-vibe-coder-101');
      const categories = [...activePanel.querySelectorAll('.vibe-category')];
      const route = [...activePanel.querySelectorAll('.vibe-route li strong')]
        .map((element) => element.textContent.trim());
      const tests = [...activePanel.querySelectorAll('.vibe-test strong')]
        .map((element) => element.textContent.trim());
      return {
        visible: !activePanel.classList.contains('hidden'),
        active: document.querySelector('[data-tab="vibe-coder-101"]').classList.contains('active'),
        categories: categories.length,
        firstOpen: categories[0]?.open,
        route,
        tests,
        promptIngredients: activePanel.querySelectorAll('.prompt-ingredient').length,
        hasParallelDevelopment: activePanel.textContent.includes('Parallel Development'),
        hasFixedWorkExplanation: activePanel.textContent.includes(
          'Why a tiny text change can still take time'
        )
      };
    })()`);
    assert(
      vibeCoder101.visible &&
        vibeCoder101.active &&
        vibeCoder101.categories === 8 &&
        vibeCoder101.firstOpen &&
        vibeCoder101.route.join(',') ===
          'Understand,Isolate,Investigate,Build,Test,Document,Deploy,Verify' &&
        vibeCoder101.tests.length === 9 &&
        vibeCoder101.tests.includes('Unit Tests') &&
        vibeCoder101.tests.includes('Browser Tests') &&
        vibeCoder101.tests.includes('Production Verification') &&
        vibeCoder101.promptIngredients === 5 &&
        vibeCoder101.hasParallelDevelopment &&
        vibeCoder101.hasFixedWorkExplanation,
      'developer area teaches the full prompt-to-production workflow in Vibe Coder 101'
    );

    const replyOptionEditor = await desktop.evaluate(`(async () => {
      document.querySelector('[data-tab="reply-options"]').click();
      await new Promise((resolve) => setTimeout(resolve, 250));
      const response = await fetch('/api/dev/reply-options');
      const data = await response.json();
      return {
        responseOk: response.ok,
        systemCards: document.querySelectorAll('#systemReplyOptions .reply-option').length,
        commands: [...document.querySelectorAll('#systemReplyOptions .reply-command')]
          .map((element) => element.textContent.trim()).join(','),
        form: Boolean(document.getElementById('replyOptionForm')),
        audienceChoices: document.getElementById('replyOptionAudience').options.length,
        availableCommands: document.getElementById('replyOptionCommand').options.length,
        tokens: document.getElementById('replyOptionTokens').textContent,
        apiCommands: data.systemOptions.map((option) => option.command).join(',')
      };
    })()`);
    assert(
      replyOptionEditor.responseOk &&
        replyOptionEditor.systemCards === 3 &&
        replyOptionEditor.commands === '1,2,9' &&
        replyOptionEditor.form &&
        replyOptionEditor.audienceChoices === 3 &&
        replyOptionEditor.availableCommands === 7 &&
        replyOptionEditor.tokens.includes('{LOCATION}') &&
        replyOptionEditor.tokens.includes('{MANAGEMENT_LINK}') &&
        replyOptionEditor.apiCommands === '1,2,9',
      'developer area inventories built-in SMS replies and can create role-specific options'
    );

    const youreInEditor = await desktop.evaluate(`(async () => {
      const textMessagingTab = document.getElementById('textMessagingTab');
      textMessagingTab.click();
      const dropdownOpened = {
        label: textMessagingTab.textContent.trim().replace('▼', '').trim(),
        expanded: textMessagingTab.getAttribute('aria-expanded') === 'true',
        visible: !document.getElementById('textMessagingMenu').classList.contains('hidden')
      };
      document.querySelector('[data-tab="youre-in"]').click();
      await new Promise((resolve) => setTimeout(resolve, 250));
      const categoryTabs = [
        'youre-in', 'waitlist-confirmation', 'application-confirmation',
        'roster-status-change', 'player-cancellation', 'upcoming-reminder',
        'game-cancelled', 'organizer-announcement', 'game-created', 'host-alerts',
        'management-links', 'game-details', 'cancellation-help'
      ];
      const messages = document.querySelectorAll('#youreInList .slogan-entry').length;
      const editButtons = document.querySelectorAll('[data-action="edit-youre-in"]').length;
      const first = document.querySelector('#youreInList .copy')?.textContent || '';
      document.getElementById('addAnotherText').click();
      const bulkFields = document.querySelectorAll('#bulkMessageFields .text-message-input').length;
      const bulkButton = document.getElementById('addAllTexts').textContent.trim();
      const detailsEditor = {
        form: Boolean(document.getElementById('textMessageDetailsForm')),
        value: document.getElementById('textMessageDetailsTemplate')?.value || '',
        save: document.querySelector('#textMessageDetailsForm button[type="submit"]')?.textContent.trim()
      };
      const youreInLiveNote = !document.getElementById('textMessageLiveNote').classList.contains('hidden');
      document.querySelector('[data-tab="waitlist-confirmation"]').click();
      await new Promise((resolve) => setTimeout(resolve, 40));
      const waitlistToggle = {
        visible: !document.getElementById('textMessageMode').classList.contains('hidden'),
        off: document.getElementById('useRandomTexts').checked === false,
        fallback: document.getElementById('textMessageModeDetail').textContent.includes('current app text'),
        tokens: document.getElementById('textMessageTokenList').textContent.includes('{DEFAULT_TEXT}')
      };
      document.querySelector('[data-tab="application-confirmation"]').click();
      await new Promise((resolve) => setTimeout(resolve, 40));
      const consecutiveToggleVisible =
        !document.getElementById('textMessageMode').classList.contains('hidden');
      document.querySelector('[data-tab="youre-in"]').click();
      await new Promise((resolve) => setTimeout(resolve, 40));
      document.querySelector('[data-action="edit-youre-in"]')?.click();
      const form = document.querySelector('.youre-in-edit-form');
      const input = form?.querySelector('textarea');
      const result = {
        messages,
        editButtons,
        startsWithYoureIn: first.startsWith("You're IN"),
        form: Boolean(document.getElementById('youreInForm')),
        dropdownOpened,
        topLevelCategoryTabs:
          document.querySelectorAll('.tabs > button[data-tab="youre-in"]').length,
        dropdownActive: textMessagingTab.classList.contains('active'),
        dropdownClosed:
          textMessagingTab.getAttribute('aria-expanded') === 'false' &&
          document.getElementById('textMessagingMenu').classList.contains('hidden'),
        categoryTabs: categoryTabs.filter((id) => document.querySelector('[data-tab="' + id + '"]')).length,
        preview: document.getElementById('textMessagePreviewBody')?.textContent.includes('Pickleball at'),
        bulkFields,
        bulkButton,
        bulkPaste: Boolean(document.getElementById('bulkPasteTexts')),
        detailsEditor,
        youreInLiveNote,
        waitlistToggle,
        consecutiveToggleVisible,
        focused: document.activeElement === input,
        save: form?.querySelector('button[type="submit"]')?.textContent.trim(),
        cancel: form?.querySelector('[data-action="cancel-edit-youre-in"]')?.textContent.trim()
      };
      form?.querySelector('[data-action="cancel-edit-youre-in"]')?.click();
      result.cancelled = !document.querySelector('.youre-in-edit-form');
      return result;
    })()`);
    // One combined assert here used to hide which of ~30 conditions failed, and its
    // message-count pin was a literal 22 that went stale when the DUPR message was cut
    // (588489c) - the smoke kept passing only because the primary database's saved
    // youre-in-config still held the old count. The expected count now comes from the
    // code's own default list, and each contract asserts separately so a failure names
    // itself. The shadowing is gone too: this server has a database of its own, so there
    // is no saved youre-in-config for the defaults to lose to.
    const expectedYoureInMessages = require('../youre-in-messages').DEFAULT_MESSAGES.length;
    assert(
      youreInEditor.messages === expectedYoureInMessages &&
        youreInEditor.editButtons === youreInEditor.messages &&
        youreInEditor.startsWithYoureIn &&
        youreInEditor.form,
      `developer area lists every default You're IN message with edit controls (saw ${youreInEditor.messages}, expected ${expectedYoureInMessages})`
    );
    assert(
      youreInEditor.dropdownOpened.label === 'Text Messaging' &&
        youreInEditor.dropdownOpened.expanded &&
        youreInEditor.dropdownOpened.visible &&
        youreInEditor.topLevelCategoryTabs === 0 &&
        youreInEditor.dropdownActive &&
        youreInEditor.dropdownClosed &&
        youreInEditor.categoryTabs === 13,
      'text messaging dropdown opens, closes, and groups all 13 categories'
    );
    assert(youreInEditor.preview, 'text message preview renders a sample message');
    assert(
      youreInEditor.bulkFields === 2 &&
        youreInEditor.bulkButton === 'Add All 2 Openings' &&
        youreInEditor.bulkPaste,
      'bulk entry offers two openings and a paste box'
    );
    assert(
      youreInEditor.detailsEditor.form &&
        youreInEditor.detailsEditor.value.includes('{LOCATION}') &&
        youreInEditor.detailsEditor.value.includes('{TOTAL_PLAYERS}') &&
        youreInEditor.detailsEditor.save === 'Save Details',
      'details template editor exposes its tokens and save control'
    );
    assert(
      youreInEditor.youreInLiveNote &&
        youreInEditor.waitlistToggle.visible &&
        youreInEditor.waitlistToggle.off &&
        youreInEditor.waitlistToggle.fallback &&
        youreInEditor.waitlistToggle.tokens &&
        youreInEditor.consecutiveToggleVisible,
      'randomizer mode toggles and fallback notes show per category'
    );
    assert(
      youreInEditor.focused &&
        youreInEditor.save === 'Save' &&
        youreInEditor.cancel === 'Cancel' &&
        youreInEditor.cancelled,
      "inline You're IN editing focuses its field and can be cancelled"
    );

    const mobile = await browser.newPage({
      width: 420,
      height: 900,
      deviceScaleFactor: 2,
      mobile: true
    });
    await mobile.goto(`${local.baseUrl}/game.html?id=${fx.open.gameId}`);
    const gameReady = await mobile.evaluate(`(() => ({
      visible: getComputedStyle(document.getElementById('details')).display !== 'none',
      // There is no PageUtils global to look for any more. A 12-hour time on the page is the
      // stronger proof anyway: it is only there if game-page.js imported page-utils.js and ran
      // formatTime12Hour, and a failed import would have stopped the module before this.
      pageUtils: /\\d{1,2}:\\d{2}\\s?(AM|PM)/.test(document.getElementById('details').innerText),
      external: [...document.scripts].some((s) => s.src.endsWith('/js/game-page.js')),
      locationOnly: !document.getElementById('court' + 'Number') &&
        !document.body.innerText.includes(['Court', 'Number'].join(' '))
    }))()`);
    assert(gameReady.visible && gameReady.pageUtils, 'mobile game page initializes with shared utilities');
    assert(gameReady.external, 'game page uses its external script');
    assert(gameReady.locationOnly, 'player game details use location without a separate court field');

    // Answering twice from a browser that does not remember you - a second phone, a cleared
    // browser, a shared tablet - used to come back as a red failure over a roster that already
    // had your name on it.
    const firstJoin = await mobile.evaluate(`(async () => {
      document.getElementById('playerName').value = 'Twice Tapper';
      document.getElementById('phoneNumber').value = '${fx.JOIN_PHONE}';
      document.getElementById('joinButton').click();
      await new Promise((resolve) => setTimeout(resolve, 1400));
      return {
        confirmed: getComputedStyle(document.getElementById('confirmationSection')).display !== 'none'
      };
    })()`);
    assert(firstJoin.confirmed, 'a first-time player can still sign up from the game page');

    await mobile.evaluate(`localStorage.clear()`);
    await mobile.goto(`${local.baseUrl}/game.html?id=${fx.open.gameId}`);
    const secondJoin = await mobile.evaluate(`(async () => {
      document.getElementById('playerName').value = 'Twice Tapper';
      document.getElementById('phoneNumber').value = '${fx.JOIN_PHONE}';
      document.getElementById('joinButton').click();
      await new Promise((resolve) => setTimeout(resolve, 1400));
      const banner = document.getElementById('status');
      const card = document.getElementById('yourStatusSection');
      return {
        errored: banner.className === 'error',
        bannerText: banner.textContent,
        cardVisible: getComputedStyle(card).display !== 'none',
        cardTitle: document.getElementById('yourStatusTitle').textContent,
        formHidden: getComputedStyle(document.getElementById('signupForm')).display === 'none'
      };
    })()`);
    assert(
      !secondJoin.errored &&
        /already IN/.test(secondJoin.bannerText) &&
        secondJoin.cardVisible &&
        secondJoin.cardTitle === "You're IN" &&
        secondJoin.formHidden,
      'tapping IN when already signed up shows the player their standing, not an error'
    );

    const hostDelete = await desktop.evaluate(`(async () => {
      document.querySelector('[data-tab="rosters"]').click();
      await new Promise((resolve) => setTimeout(resolve, 250));
      const host = document.querySelector('[data-host-phone="${fx.HOST_PHONE}"]');
      host.querySelector('[data-host-action="delete"]').click();
      const warning = host.querySelector('.host-delete-confirm');
      const warned = !warning.classList.contains('hidden') &&
        warning.textContent.includes('including every game they host') &&
        warning.textContent.includes('People listed with other hosts will remain there');
      warning.querySelector('[data-host-action="confirm-delete"]').click();
      await new Promise((resolve) => setTimeout(resolve, 450));
      const response = await fetch('/api/dev/rosters?source=local');
      const directory = await response.json();
      return {
        warned,
        removed: !document.querySelector('[data-host-phone="${fx.HOST_PHONE}"]'),
        gamesRemoved: directory.hosts.every((item) => item.phone !== '${fx.HOST_PHONE}')
      };
    })()`);
    assert(
      hostDelete.warned && hostDelete.removed && hostDelete.gamesRemoved,
      'deleting a host requires a specific warning and removes the host’s games and roster'
    );

    await desktop.close();
    await mobile.close();
  } finally {
    if (browser) await browser.close();
    await local.stop();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
