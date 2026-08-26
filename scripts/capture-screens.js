// Photographs the running app, one screen at a time, and writes a gallery grouped by page file.
//
//   npm run docs:screens            # desktop widths
//   npm run docs:screens -- --phone # phone widths, which is how most players actually arrive
//   node scripts/capture-screens.js --only=manage    # just the screens whose name matches
//
// Produces docs/screens.html plus docs/screens/*.webp.
//
// What it does, in order: starts a throwaway copy of the app on a free port with SMS in dev mode,
// seeds three demo games, drives headless Chrome through the real pages - filling in forms,
// clicking tabs, signing up as a player - then deletes the demo games and stops the server.
//
// No text messages are sent: lib/local-server.js blanks TEXTBELT_API_KEY, so every send takes
// the dev-mode branch. It also refuses to run if DATABASE_URL is set, because the demo games
// must never be created against production.
//
// To add or change a screen, edit SCREENS below. Each entry names the page file it belongs to,
// so a screenshot always stays tied to the file you would edit to change it.

const fs = require('fs');
const path = require('path');
const cdp = require('./lib/cdp');
const server = require('./lib/local-server');
const fixtures = require('./lib/fixtures');
const { page, escapeHtml: esc, generatedNote } = require('./lib/doc-shell');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'docs');

const PHONE = process.argv.includes('--phone');
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').split('=')[1] || '';
const KEEP = process.argv.includes('--keep-fixtures');

// Phone and desktop runs keep separate folders and separate gallery files, so running one does
// not half-overwrite the other's images with a different width.
const SHOT_DIR = path.join(OUT_DIR, PHONE ? 'screens-phone' : 'screens');
const SHOT_REL = PHONE ? 'screens-phone' : 'screens';
const GALLERY = PHONE ? 'screens-phone.html' : 'screens.html';

// Phone captures are narrow, so they can afford a sharper pixel ratio and better quality at the
// same file size. Wide pages get scaled down instead, and the very tall ones lean on WebP.
const SIZE = PHONE
  ? { narrow: { w: 420, dsf: 2, q: 72 }, wide: { w: 420, dsf: 2, q: 72 }, tall: { w: 420, dsf: 2, q: 64 } }
  : { narrow: { w: 900, dsf: 1.5, q: 78 }, wide: { w: 1040, dsf: 1.25, q: 78 }, tall: { w: 900, dsf: 1, q: 60 } };

/** Opens one of the guide's collapsible sections; they are hidden until a card is tapped. */
const openGuideSection = (id) => async (p) => {
  await p.evaluate(`(() => {
    const card = document.querySelector("[data-section='${id}']");
    if (card) card.click(); else showSection('${id}', null);
    window.scrollTo(0, 0);
  })()`);
  await cdp.sleep(1100);
};

const showCreateLoading = (fx) => async (p) => {
  await p.evaluate(`(() => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = (url, options) => {
      if (url === '/api/games' && options?.method === 'POST') return new Promise(() => {});
      return originalFetch(url, options);
    };
    const set = (id, v) => { const e = document.getElementById(id); e.value = v;
      e.dispatchEvent(new Event('input', { bubbles: true })); };
    const select = document.getElementById('locationSelect');
    select.value = '__new__';
    select.dispatchEvent(new Event('change'));
    set('location', 'Sunset Park Courts');
    set('organizerName', 'Scott H.'); set('organizerPhone', '${fx.FORM_PHONE}');
    set('date', '${fixtures.inDays(4)}'); set('time', '17:30'); set('players', '4');
    document.getElementById('gameForm').requestSubmit();
  })()`);
  await cdp.sleep(350);
};

const signUpAsPlayer = (fx) => async (p) => {
  // The phone field is required, so a signup cannot be photographed without one. This number is
  // only ever texted in dev mode. It must be unused on this game or the join is rejected as a
  // duplicate - which is why the fixtures are freshly seeded on every run.
  await p.evaluate(`(() => {
    const set = (id, v) => { const e = document.getElementById(id); e.value = v;
      e.dispatchEvent(new Event('input', { bubbles: true })); };
    set('playerName', 'Sam Rivera'); set('phoneNumber', '${fx.JOIN_PHONE}');
    document.getElementById('joinButton').click();
  })()`);
  await cdp.sleep(2600);
};

/**
 * Puts the browser in the state a player is in every time after their first answer: the page
 * remembers them, so it opens on their own status rather than an empty form. Reloading is the
 * point - it proves the card survives closing the page and tapping the text link again.
 */
const returnAsRememberedPlayer = (fx) => async (p) => {
  // The signup is a no-op if the screen before this one already put Sam on the roster, so the
  // identity is written directly rather than relying on that signup having gone through.
  await signUpAsPlayer(fx)(p);
  await p.evaluate(`(() => {
    localStorage.setItem('inorout-player', JSON.stringify({
      name: 'Sam Rivera', phone: '${fx.JOIN_PHONE}'
    }));
    location.reload();
  })()`);
  await cdp.sleep(2600);
};

const clickTab = (i) => async (p) => {
  await p.evaluate(`document.querySelectorAll('.tab')[${i}].click()`);
  await cdp.sleep(1000);
};

/**
 * The Invite tab is only worth photographing with something on it. This verifies the host's
 * phone (which is also what reveals the Add Someone New form), puts one extra person on the
 * saved roster, and really texts both invitations - so the gallery shows the scoreboard with
 * one reply in and one still outstanding.
 */
const seedInviteActivity = (fx) => async (p) => {
  await p.evaluate(`(async () => {
    const phone = '${fx.HOST_PHONE}';
    const requested = await fetch('/api/host-verification/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone })
    }).then((response) => response.json());
    const verified = await fetch('/api/host-verification/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, code: requested.devCode })
    }).then((response) => response.json());
    if (!verified.token) throw new Error('Host verification fixture failed');
    localStorage.setItem('hostPhone', phone);
    localStorage.setItem('hostVerificationToken', verified.token);

    for (const person of [
      { number: '${fx.FORM_PHONE}', name: 'Jordan Blake' },
      { number: '${fx.JOIN_PHONE}', name: 'Sam Rivera' }
    ]) {
      await fetch('/api/roster/' + phone + '/' + person.number, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + verified.token },
        body: JSON.stringify({ name: person.name })
      });
    }

    // One invitation has to come back answered for the gallery to show both states. Sam Rivera
    // signs up here when the game-joined screen was filtered out of the run; when it ran, this
    // is a duplicate the server rejects and the answer is already on the game.
    const game = await fetch('/api/games/${fx.open.gameId}').then((r) => r.json());
    const joined = (game.players || []).some(
      (player) => String(player.phone || '').replace(/\\D/g, '').endsWith('${fx.JOIN_PHONE}')
    );
    if (!joined) {
      await fetch('/api/games/${fx.open.gameId}/players', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Sam Rivera', phone: '${fx.JOIN_PHONE}', action: 'join' })
      });
    }

    await fetch('/api/games/${fx.open.gameId}/invitations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: '${fx.open.hostToken}',
        playerPhones: ['${fx.FORM_PHONE}', '${fx.JOIN_PHONE}']
      })
    });
    location.reload();
  })()`);
  await cdp.sleep(2800);
};

// My Games, Roster and Stats share a verified host session. The local SMS client returns its
// simulated code only in local development, so the gallery can exercise the real request and
// confirmation endpoints without sending a text.
const seedHostPhone = (fx, hostPhone = fx.HOST_PHONE) => async (p) => {
  await p.evaluate(`(async () => {
    const phone = ${JSON.stringify(hostPhone)};
    if (localStorage.getItem('hostVerificationToken') &&
        localStorage.getItem('hostPhone') === phone) {
      location.reload();
      return;
    }
    const requested = await fetch('/api/host-verification/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone })
    }).then((response) => response.json());
    const verified = await fetch('/api/host-verification/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, code: requested.devCode })
    }).then((response) => response.json());
    if (!verified.token) throw new Error('Host verification fixture failed');
    localStorage.setItem('hostPhone', phone);
    localStorage.setItem('hostVerificationToken', verified.token);
    location.reload();
  })()`);
  await cdp.sleep(2600);
};

const clearHostPhone = async (p) => {
  await p.evaluate(`localStorage.removeItem('hostPhone');
    localStorage.removeItem('hostVerificationToken'); location.reload()`);
  await cdp.sleep(2000);
};

// The developer-area sign-in every dev screen needs, as one snippet.
//
// The sign-in cookie lasts thirty days and the browser holds it across screens, so asking for
// a fresh one per screen was never necessary - and /api/dev/login is rate limited to ten
// attempts per fifteen minutes, which a full run of the dev screens now sits right on top of.
// Checking /api/dev/status first means one password post per run instead of one per screen.
const devSignInSnippet = () => `
    const alreadyIn = await fetch('/api/dev/status');
    if (!alreadyIn.ok) {
      const response = await fetch('/api/dev/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: ${JSON.stringify(server.DEV_PASSWORD)} })
      });
      if (!response.ok) throw new Error('Developer sign-in failed');
    }
    DevDashboard.showApp();`;

const openDeveloperRosters = async (p) => {
  await p.evaluate(`(async () => {
    ${devSignInSnippet()}
    document.querySelector('[data-tab="rosters"]').click();
  })()`);
  await cdp.sleep(1400);
  // The capture server shares the developer's local SQLite database. Keep unrelated local
  // contacts out of the generated image and photograph only reserved fixture phone numbers.
  await p.evaluate(`(() => {
    const search = document.getElementById('rosterSearch');
    search.value = '555555';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#hostRosterList [data-host-action="delete"]')?.click();
  })()`);
  await cdp.sleep(300);
};

// The starter-roster picker, open on a fixture host. This photographs the controls only -
// it deliberately creates no host, because the capture server shares the developer's local
// SQLite database and a screenshot must not leave a row behind in it.
//
// Deliberately not built on openDeveloperRosters: that one opens a delete confirmation, which
// belongs in its own screenshot and would read here as though deleting were part of this flow.
const openDeveloperStarterRoster = async (p) => {
  await p.evaluate(`(async () => {
    ${devSignInSnippet()}
    document.querySelector('[data-tab="rosters"]').click();
  })()`);
  await cdp.sleep(1400);
  // Same reason as openDeveloperRosters: this shares the developer's local SQLite database,
  // so both lists are filtered to the reserved 555 fixture numbers and no real contact of
  // Scott's can appear in a generated image.
  await p.evaluate(`(async () => {
    const search = document.getElementById('rosterSearch');
    search.value = '5555550';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 120));
    const card = document.querySelector('#hostRosterList .host-roster');
    if (!card) return;
    card.querySelector('[data-host-action="pick"]').click();
    await new Promise((resolve) => setTimeout(resolve, 180));
    const picker = card.querySelector('.host-picker-search');
    if (picker) {
      picker.value = '5555550';
      picker.dispatchEvent(new Event('input', { bubbles: true }));
    }
  })()`);
  await cdp.sleep(400);
};

const openDeveloperStatus = async (p) => {
  await p.evaluate(`(async () => {
    ${devSignInSnippet()}
    document.querySelector('[data-tab="status"]').click();
  })()`);
  await cdp.sleep(900);
};

const openDeveloperMessageRandomizer = async (p) => {
  await p.evaluate(`(async () => {
    ${devSignInSnippet()}
    document.querySelector('[data-tab="message-randomizer"]').click();
  })()`);
  await cdp.sleep(1000);
  await p.evaluate(`(() => {
    const surface = document.getElementById('randomizerLibrarySurface');
    const status = document.getElementById('randomizerLibraryStatus');
    surface.value = 'game-details';
    status.value = '';
    surface.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await cdp.sleep(700);
};

const openDeveloperMessageRandomizerPreview = async (p) => {
  await openDeveloperMessageRandomizer(p);
  await p.evaluate(`document.querySelector(
    '#randomizerSurfaceRows tr[data-surface-id="site-slogan"] [data-action="surface-preview"]'
  ).click()`);
  await cdp.sleep(700);
};

const openDeveloperMessageRandomizerGeneration = async (p) => {
  await openDeveloperMessageRandomizer(p);
  await p.evaluate(`(() => {
    const section = [...document.querySelectorAll('[data-randomizer-section]')]
      .find((candidate) => candidate.querySelector('summary h2')?.textContent.trim() === 'Generate Fresh Messages');
    section.open = true;
    section.scrollIntoView({ block: 'start' });
  })()`);
  await cdp.sleep(400);
};

const openDeveloperMessageRandomizerPrompts = async (p) => {
  await openDeveloperMessageRandomizer(p);
  await p.evaluate(`(() => {
    const section = [...document.querySelectorAll('[data-randomizer-section]')]
      .find((candidate) => candidate.querySelector('summary h2')?.textContent.trim() === 'Build Messages With Codex');
    section.open = true;
    section.scrollIntoView({ block: 'start' });
  })()`);
  await cdp.sleep(400);
};

const openDeveloperRules = async (p) => {
  await p.evaluate(`(async () => {
    ${devSignInSnippet()}
    document.querySelector('[data-tab="rules"]').click();
  })()`);
  await cdp.sleep(500);
};

const openDeveloperVibeCoder101 = async (p) => {
  await p.evaluate(`(async () => {
    ${devSignInSnippet()}
    document.querySelector('[data-tab="vibe-coder-101"]').click();
  })()`);
  await cdp.sleep(250);
};

const openDeveloperVibeCoder101Testing = async (p) => {
  await openDeveloperVibeCoder101(p);
  await p.evaluate(`(() => {
    const categories = [...document.querySelectorAll('#tab-vibe-coder-101 .vibe-category')];
    categories.forEach((category, index) => {
      category.open = index === 4;
    });
  })()`);
  await cdp.sleep(250);
};

const openDeveloperImages = (fx) => async (p) => {
  // Reuse a real app screenshot as the fixture image so the gallery photographs recognisable
  // thumbnails without keeping a second decorative image asset in the repository.
  const fixturePath = path.join(ROOT, 'docs', 'screens', 'game-open.webp');
  const imageBase64 = fs.readFileSync(fixturePath).toString('base64');
  await p.evaluate(`(async () => {
    ${devSignInSnippet()}
    const bytes = Uint8Array.from(
      atob(${JSON.stringify(imageBase64)}),
      (character) => character.charCodeAt(0)
    );
    const courtUpload = await fetch(
      '/api/games/${fx.open.gameId}/court-images?token=${fx.open.hostToken}',
      { method: 'POST', headers: { 'Content-Type': 'image/webp' }, body: bytes }
    );
    const gameUpload = await fetch(
      '/api/games/${fx.open.gameId}/photos?token=${fx.open.hostToken}&caption=After-game%20group%20photo',
      { method: 'POST', headers: { 'Content-Type': 'image/webp' }, body: bytes }
    );
    if (!courtUpload.ok || !gameUpload.ok) throw new Error('Image fixture upload failed');
    DevDashboard.showApp();
    document.querySelector('[data-tab="images"]').click();
  })()`);
  await cdp.sleep(900);
};

const GUIDE_SECTIONS = [
  ['game-modes', 'Game Modes Explained', 'First-come versus approval, side by side.'],
  ['creating-games', 'Creating Your First Game', 'Setup walkthrough for both modes.'],
  ['managing-players', 'Managing Your Game', 'Finding your management link, then running the roster.'],
  ['tips-tricks', 'FAQs', 'Setup, management and troubleshooting questions.'],
];

/**
 * Two extra demo games for states the three standard fixtures cannot show: a game close enough
 * to photograph the game-day card, and a host whose calendar is empty.
 *
 * They are created here rather than in lib/fixtures.js so the browser smoke test keeps the
 * exact three games its assertions count. Both carry the fixture MARKER and a fixture 555 host
 * number, which is what fixtures.cleanup() matches on, so they are swept with the rest.
 */
async function seedStateFixtures(baseUrl, fx) {
  const post = async (pathname, body) => {
    const response = await fetch(baseUrl + pathname, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`POST ${pathname} -> ${response.status} ${JSON.stringify(json)}`);
    return json;
  };

  // Six hours out: comfortably inside the 24-hour game-day window and still in the future even
  // if this machine's clock is a few hours off the Central Time the server checks expiry in.
  const soon = new Date(Date.now() + 6 * 60 * 60 * 1000);
  const gameDay = await post('/api/games', {
    location: 'Oak Park Courts',
    organizerName: 'Scott H.',
    organizerPhone: fixtures.HOST_PHONE,
    organizerPlaying: true,
    date: `${soon.getFullYear()}-${String(soon.getMonth() + 1).padStart(2, '0')}-${String(soon.getDate()).padStart(2, '0')}`,
    time: `${String(soon.getHours()).padStart(2, '0')}:${String(soon.getMinutes()).padStart(2, '0')}`,
    duration: '90',
    totalPlayers: '4',
    message: `Tonight. Bring a light jacket. ${fixtures.MARKER}`,
    registrationMode: 'fcfs',
    notifyPlayerCancels: true,
  });
  for (const name of ['Maria Alvarez', 'Dev Patel', 'Tom Whitfield']) {
    await post(`/api/games/${gameDay.gameId}/players`, { name, action: 'join' });
  }

  // A second host with one game, cancelled, and nothing upcoming - the state the Run It Again
  // card exists for. FORM_PHONE is already a fixture number, so cleanup sweeps this too.
  const lapsed = await post('/api/games', {
    location: 'Lakeside Park',
    organizerName: 'Jordan Blake',
    organizerPhone: fixtures.FORM_PHONE,
    organizerPlaying: true,
    date: fixtures.inDays(2),
    time: '18:30',
    duration: '90',
    totalPlayers: '4',
    message: `Thursday regulars. ${fixtures.MARKER}`,
    registrationMode: 'fcfs',
  });
  await fetch(`${baseUrl}/api/games/${lapsed.gameId}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: lapsed.hostToken, reason: 'Court flooded' }),
  });

  return { gameDay, lapsed };
}

/** The screens to capture, in reading order. fx is the seeded fixture data. */
function buildScreens(fx) {
  return [
    { file: 'index-landing', of: '/', size: 'wide', url: '/',
      title: 'The landing view',
      note: 'What everyone lands on: a line from the slogan rotation and the one button. The detailed guide below it is a section picker — each section stays hidden until you tap a card.' },
    ...GUIDE_SECTIONS.map(([id, title, note]) => ({
      file: `index-guide-${id}`, of: '/', size: 'tall', url: '/',
      title: `Guide — ${title}`, note, act: openGuideSection(id),
    })),

    { file: 'create-form', of: '/create.html', size: 'narrow', url: '/create.html',
      title: 'The form, top to bottom',
      note: 'Everything a host fills in, including the five notification toggles.' },
    // Grouped under /create.html: same file, filled in from a past game. A group heading only
    // exists for each `of` in GROUPS, and a screen with an unlisted `of` is silently dropped.
    { file: 'create-repeat', of: '/create.html', size: 'narrow',
      url: `/create.html?repeat=${fx.open.gameId}&token=${fx.open.hostToken}`,
      title: 'Run It Again',
      note: 'Reached from a past game in My Games. Every field is copied from that game and the date moves to the next same weekday. Nothing is created until the host submits.' },
    { file: 'create-loading', of: '/create.html', size: 'narrow', url: '/create.html',
      title: 'While The Game Is Created',
      note: 'The pickleball loading screen appears immediately and stays up until Game Management opens.',
      act: showCreateLoading(fx) },

    { file: 'game-open', of: '/game.html?id=…', size: 'narrow', url: `/game.html?id=${fx.open.gameId}`,
      title: 'Spots still open',
      note: 'A first-come game with 2 of 6 spots left. Whose game it is, when, where and how much room is left all sit at the top, with IN or OUT immediately under them; the full details and the public roster follow below.' },
    { file: 'game-joined', of: '/game.html?id=…', size: 'narrow', url: `/game.html?id=${fx.open.gameId}`,
      title: 'After tapping IN',
      note: 'The confirmation replaces the whole page. Reached by really signing up — note the phone number is required.',
      act: signUpAsPlayer(fx) },
    { file: 'game-returning', of: '/game.html?id=…', size: 'narrow',
      url: `/game.html?id=${fx.open.gameId}`,
      title: 'Opening the link again',
      note: 'Once this browser has answered once, the link opens on the player\'s own status instead of a blank form. Changing their mind is one tap, and nothing has to be typed again.',
      act: returnAsRememberedPlayer(fx) },
    { file: 'game-full', of: '/game.html?id=…', size: 'narrow', url: `/game.html?id=${fx.full.gameId}`,
      title: 'Game full',
      note: 'Same file, different state: the signup form becomes a waitlist signup.' },
    { file: 'game-approval', of: '/game.html?id=…', size: 'narrow', url: `/game.html?id=${fx.approval.gameId}`,
      title: 'Approval mode',
      note: 'The roster is hidden. Everyone applies and waits to be picked.' },
    { file: 'game-cancelled', of: '/game.html?id=…', size: 'narrow', url: `/game.html?id=${fx.lapsed.gameId}`,
      title: 'Cancelled game',
      note: 'The same link after the host called it off. The notice sits above the details so it is the first thing on the screen, and the signup form is gone.' },

    { file: 'manage-invite', of: '/manage.html?id=…&token=…', size: 'wide',
      url: `/manage.html?id=${fx.open.gameId}&token=${fx.open.hostToken}&tab=Invite`,
      title: 'Invite tab',
      note: 'The tab that opens first. Tick names, send, and read the answers back: every invitation with its reply, or No Reply and a way to chase it.',
      act: seedInviteActivity(fx) },
    { file: 'manage-players', of: '/manage.html?id=…&token=…', size: 'wide',
      url: `/manage.html?id=${fx.open.gameId}&token=${fx.open.hostToken}`,
      title: 'Players tab',
      note: 'Confirmed, waitlist and out lists, plus adding someone by hand. Players who said OUT can be added back or cleared, and photos live here so they can still be added after the game ends.', act: clickTab(1) },
    { file: 'manage-communication', of: '/manage.html?id=…&token=…', size: 'wide',
      url: `/manage.html?id=${fx.open.gameId}&token=${fx.open.hostToken}`,
      title: 'Communication tab',
      note: 'Announce to everyone or one person, plus the quick reminder and location buttons.', act: clickTab(2) },
    { file: 'manage-details', of: '/manage.html?id=…&token=…', size: 'wide',
      url: `/manage.html?id=${fx.open.gameId}&token=${fx.open.hostToken}`,
      title: 'Game Details tab',
      note: 'Moving the court, date, time or duration texts everyone signed up, unless the host unticks the box. Cancelling the game lives at the foot of this tab.', act: clickTab(3) },
    { file: 'manage-approval-roster', of: '/manage.html?id=…&token=…', size: 'wide',
      url: `/manage.html?id=${fx.approval.gameId}&token=${fx.approval.hostToken}`,
      title: 'Players tab on an approval game',
      note: 'Three applicants waiting. Nobody is confirmed until the host promotes them.', act: clickTab(1) },
    { file: 'manage-game-day', of: '/manage.html?id=…&token=…', size: 'wide',
      url: `/manage.html?id=${fx.gameDay.gameId}&token=${fx.gameDay.hostToken}`,
      title: 'Game day',
      note: 'Inside 24 hours a card appears above the tabs with the two day-of sends and a jump to the delivery log. It is gone again once the game is over or cancelled.' },
    { file: 'manage-wrong-token', of: '/manage.html?id=…&token=…', size: 'narrow',
      url: `/manage.html?id=${fx.open.gameId}&token=wrong-token-value`,
      title: 'Wrong or missing token', note: 'What anyone without the host link sees.' },

    { file: 'my-games-gate', of: '/my-games.html', size: 'narrow', url: '/my-games.html',
      title: 'Verifying the host number',
      note: 'What a host sees on a new device. A texted code confirms that the organizer actually controls the phone number.',
      act: clearHostPhone },
    { file: 'my-games-list', of: '/my-games.html', size: 'narrow', url: '/my-games.html',
      title: 'The host history',
      note: 'Loaded after phone verification, split into upcoming and past. Each card has Manage, Copy Invitation and a private note.',
      act: seedHostPhone(fx) },
    { file: 'my-games-run-it-again', of: '/my-games.html', size: 'narrow', url: '/my-games.html',
      title: 'Nothing coming up',
      note: 'A host with a history but an empty calendar is offered their last game back, straight into the prefilled repeat form, instead of an empty Upcoming heading.',
      act: seedHostPhone(fx, fx.FORM_PHONE) },

    { file: 'roster-list', of: '/roster.html', size: 'narrow', url: '/roster.html',
      title: 'Everyone you play with',
      note: 'Built automatically from who has signed up for the host\'s games. Names the host enters are their own and players never see them.',
      act: seedHostPhone(fx) },

    { file: 'stats-dashboard', of: '/stats.html', size: 'narrow', url: '/stats.html',
      title: 'Host stats',
      note: 'Worked out from the games actually hosted. The yellow notes are deliberate: where a number cannot yet be trusted, the page says so.',
      act: seedHostPhone(fx) },

    { file: 'dev-hosts-and-players', of: '/dev.html', size: 'wide', url: '/dev.html',
      title: 'Hosts And Players',
      note: 'The password-protected master player roster and every host roster, with guarded global edit and delete controls.',
      act: openDeveloperRosters },
    { file: 'dev-add-host-starter-roster', of: '/dev.html', size: 'tall', url: '/dev.html',
      title: 'Add A Host And Their Starter Roster',
      note: 'Setting a host up before their first visit, then picking who they start with from every player already in the app. Nobody is texted, and the phone number entered here is the one that host must create their game with.',
      act: openDeveloperStarterRoster },
    { file: 'dev-status-text-events', of: '/dev.html', size: 'tall', url: '/dev.html',
      title: 'Status And Text Events',
      note: 'Live operational health plus every outbound text trigger, with totals, recent counts, failures, retries and unique recipients.',
      act: openDeveloperStatus },
    { file: 'dev-message-randomizer', of: '/dev.html', size: 'tall', url: '/dev.html',
      title: 'Message Randomizer',
      note: 'Seven collapsed sections keep the full Message Randomizer toolkit easy to scan and open on demand.',
      act: openDeveloperMessageRandomizer },
    { file: 'dev-message-randomizer-generation', of: '/dev.html', size: 'tall', url: '/dev.html',
      title: 'Generate Fresh Messages',
      note: 'Generated candidates can be configured by surface and count; the generation action is currently marked Under Construction.',
      act: openDeveloperMessageRandomizerGeneration },
    { file: 'dev-message-randomizer-prompts', of: '/dev.html', size: 'tall', url: '/dev.html',
      title: 'Build Messages With Codex',
      note: 'Nine editable prompt paragraphs can be saved by message category, copied as one numbered prompt, or shared selectively across every category.',
      act: openDeveloperMessageRandomizerPrompts },
    { file: 'dev-message-randomizer-preview', of: '/dev.html', size: 'tall', url: '/dev.html',
      title: 'Message Randomizer Preview',
      note: 'A Surface Matrix Preview button selects that category, reveals Preview And Test and resolves stored inventory without incrementing usage.',
      act: openDeveloperMessageRandomizerPreview },
    { file: 'dev-images', of: '/dev.html', size: 'wide', url: '/dev.html',
      title: 'Images',
      note: 'Every uploaded court image and game photo, with the uploader’s name and a developer-only delete control.',
      act: openDeveloperImages(fx) },
    { file: 'dev-rules', of: '/dev.html', size: 'tall', url: '/dev.html',
      title: 'Rules',
      note: 'The living reference for build, deployment, design, privacy, test-safety and core behavior guardrails.',
      act: openDeveloperRules },
    { file: 'dev-vibe-coder-101', of: '/dev.html', size: 'tall', url: '/dev.html',
      title: 'Vibe Coder 101',
      note: 'A plain-English tour from prompt to production, with expandable workflow categories, a testing translator and a five-part prompt recipe.',
      act: openDeveloperVibeCoder101 },
    { file: 'dev-vibe-coder-101-testing', of: '/dev.html', size: 'tall', url: '/dev.html',
      title: 'Vibe Coder 101 — Testing Explained',
      note: 'Nine kinds of evidence explain what each testing layer proves, from fast static checks to live production verification and human review.',
      act: openDeveloperVibeCoder101Testing },

    { file: 'lookup-redirect', of: '/lookup.html', size: 'narrow', url: '/lookup.html',
      title: 'The retired lookup page',
      note: 'Find My Games was folded into My Games. Old texts and bookmarks still land here and are sent straight on, so nothing 404s.' },

    { file: 'demo', of: '/demo.html', size: 'narrow', url: '/demo.html',
      title: 'SMS consent walkthrough',
      note: 'Unlinked page for carrier review. Describes a signup flow the app no longer has.' },
    { file: 'privacy', of: '/privacy.html', size: 'tall', url: '/privacy.html',
      title: 'Privacy Policy', note: 'Footer-linked.' },
    { file: 'terms', of: '/terms.html', size: 'tall', url: '/terms.html',
      title: 'Terms of Service', note: 'Footer-linked.' },
  ];
}

// How the gallery groups the screens. Order here is the order on the page.
const GROUPS = [
  { of: '/', who: 'Anyone', lane: 'In the nav',
    blurb: 'The homepage. It opens with the hero — a slogan and Create Game Now — and the detailed guide sits under it as a section picker, each section hidden until you tap a card. Those sections appear here as separate screens because that is how you actually meet them.' },
  { of: '/create.html', who: 'Organizers', lane: 'In the nav',
    blurb: 'One long form, then a share panel that replaces it.' },
  { of: '/game.html?id=…', who: 'Players', lane: 'Link only',
    blurb: 'The page every player gets. One file showing four different faces depending on the game.' },
  { of: '/manage.html?id=…&token=…', who: 'The host', lane: 'Link only',
    blurb: 'The host console, behind a secret token. Four tabs plus the notices you hit when something is off.' },
  { of: '/my-games.html', who: 'Organizers', lane: 'In the nav',
    blurb: 'Asks for a phone number once, then loads that host’s whole history from the server — so it works on any device, not just the one the game was created on.' },
  { of: '/roster.html', who: 'Organizers', lane: 'In the nav',
    blurb: 'Everyone who has ever signed up for one of this host’s games, built without anybody typing a list. The host can add names on top.' },
  { of: '/stats.html', who: 'Organizers', lane: 'Linked from My Games',
    blurb: 'The patterns behind the games: who turns up, who waits, who drops out, and where and when this group actually plays.' },
  { of: '/dev.html', who: 'Developer', lane: 'Password protected',
    blurb: 'Private operational controls, including the image inventory, master player roster and every host roster.' },
  { of: '/lookup.html', who: 'Organizers', lane: 'Old links only',
    blurb: 'Retired. My Games does the phone lookup itself now, so this page just forwards — the file only exists so older texts and bookmarks keep working.' },
  { of: '/demo.html', who: 'Carrier reviewers', lane: 'Unlinked',
    blurb: 'Nothing links here. It shows a consent checkbox and a “Count Me In!” button the real signup page does not have.' },
  { of: '/privacy.html', who: 'Anyone', lane: 'In the footer', blurb: 'Linked from the footer.' },
  { of: '/terms.html', who: 'Anyone', lane: 'In the footer', blurb: 'Linked from the footer.' },
];

function buildGallery(taken, { devSends }) {
  const slug = (s) => s.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'root';
  let nav = '';
  let body = '';
  let n = 0;

  for (const group of GROUPS) {
    const shots = taken.filter((s) => s.of === group.of);
    if (!shots.length) continue;
    const id = slug(group.of);
    nav += `<a href="#${id}"><span class="nav-route">${esc(group.of)}</span>` +
      `<span class="nav-who">${esc(group.who)}</span>` +
      `<span class="ix-count">${shots.length} screen${shots.length === 1 ? '' : 's'}</span></a>\n`;

    body += `<section class="route" id="${id}">
  <div class="route-head">
    <h2>${esc(group.of)}</h2>
    <div class="route-meta"><span class="pill p-who">${esc(group.who)}</span><span class="pill p-lane">${esc(group.lane)}</span></div>
    <p class="route-blurb">${esc(group.blurb)}</p>
  </div>
  <div class="screens">\n`;

    for (const s of shots) {
      n++;
      const tall = s.height > 2600;
      body += `    <figure class="screen">
      <figcaption>
        <div class="cap-top"><span class="shot-n">${String(n).padStart(2, '0')}</span><h3>${esc(s.title)}</h3></div>
        <p>${esc(s.note)}</p>
      </figcaption>
      <div class="frame"${tall ? ' data-tall="1"' : ''}>
        <img src="data:image/webp;base64,${s.base64}" alt="${esc(s.of)} — ${esc(s.title)}"
             width="${s.width}" height="${s.height}" loading="lazy">
      </div>
      <div class="frame-foot"><span>${s.width} &times; ${s.height} css px &middot; ${SHOT_REL}/${s.file}.webp</span>${tall ? '<button class="expand" type="button">Show full height</button>' : ''}</div>
    </figure>\n`;
    }
    body += `  </div>\n</section>\n`;
  }

  const css = `
.index a{grid-template-columns:1fr auto auto;}
.nav-route{font-family:var(--mono);font-size:.85rem;font-weight:700;color:var(--in);overflow-wrap:break-word;}
.nav-who{font-size:.85rem;color:var(--ink-2);}
.ix-count{font-family:var(--mono);font-size:.7rem;color:var(--ink-3);white-space:nowrap;}
@media (max-width:620px){.index a{grid-template-columns:1fr auto;}.nav-who{grid-column:1;}}
.route{display:flex;flex-direction:column;gap:1.5rem;scroll-margin-top:1rem;}
.route-head{display:flex;flex-direction:column;gap:.55rem;padding-bottom:1rem;border-bottom:2px solid var(--rule-strong);}
.route-head h2{font-family:var(--mono);font-size:clamp(1.05rem,2.6vw,1.5rem);color:var(--in);
 letter-spacing:-.02em;overflow-wrap:break-word;}
.route-meta{display:flex;gap:.5rem;flex-wrap:wrap;}
.route-blurb{font-size:.95rem;color:var(--ink-2);max-width:68ch;}
.screens{display:flex;flex-direction:column;gap:2.25rem;}
.screen{margin:0;display:flex;flex-direction:column;gap:.6rem;}
figcaption{display:flex;flex-direction:column;gap:.25rem;}
.cap-top{display:flex;gap:.6rem;align-items:baseline;}
.shot-n{font-family:var(--mono);font-size:.78rem;font-weight:700;color:var(--ink-3);font-variant-numeric:tabular-nums;}
figcaption p{font-size:.9rem;color:var(--ink-2);max-width:68ch;}
.frame{border:1px solid var(--rule-strong);background:var(--surface);overflow:auto;}
.frame[data-tall="1"]{max-height:78vh;resize:vertical;}
.frame.open{max-height:none;}
.frame img{display:block;width:100%;height:auto;}
.frame-foot{display:flex;justify-content:space-between;align-items:center;gap:1rem;
 font-family:var(--sans);font-size:.68rem;color:var(--ink-3);font-variant-numeric:tabular-nums;}
.expand{font-family:var(--sans);font-size:.68rem;font-weight:700;text-transform:uppercase;
 letter-spacing:.08em;background:transparent;color:var(--in);border:1px solid var(--rule-strong);
 padding:.25rem .55rem;border-radius:2px;cursor:pointer;}
.expand:hover{background:var(--in-soft);}
.expand:focus-visible{outline:2px solid var(--in);outline-offset:2px;}`;

  return page({
    title: `IN or OUT — Actual Screens${PHONE ? ' (phone)' : ''}`,
    css,
    body: `<div class="wrap">
<header class="top">
  <div class="eyebrow">IN or OUT · real screens${PHONE ? ' · phone width' : ''}</div>
  <h1>The app as a user meets it</h1>
  <p class="lede">${n} screenshots of the running app, grouped under the page file that produced them. Real pages, real seeded games — not mock-ups.</p>
  <div class="how"><p>Each group is headed by its file, so you can point at it: <code>@create.html</code> add a level field, <code>@game.html</code> move the OUT button. Where one file has several looks, the caption says which state you are seeing.</p></div>
</header>
<section>
  <div class="eyebrow" style="margin-bottom:.75rem;">The Ten Pages</div>
  <nav class="index">
${nav}  </nav>
</section>
${body}
<section class="notes">
  <div class="eyebrow">How these were made</div>
  <div class="note"><h3>Captured from the app running locally</h3>
    <p>A throwaway server on SQLite, driven by headless Chrome at ${PHONE ? 'phone' : 'roughly desktop'} width. Five demo games were seeded to fill the screens: a first-come game with 2 of 6 spots left, a full 2-player game, an approval game with three applicants, one starting in six hours, and one cancelled game belonging to a second host. The signup, the form submit, the tab clicks and the phone-number gate are real interactions.</p></div>
  <div class="note"><h3>No text messages were sent</h3>
    <p>The server ran with the Textbelt key blanked, so all ${devSends} sends took the dev-mode branch and none reached Textbelt. The demo phone numbers are fake 555 numbers, and the demo games were deleted from the local database afterwards.</p></div>
  <div class="note"><h3>Freshness</h3><p>${generatedNote(PHONE
      ? 'This is the phone-width set; run without --phone for desktop.'
      : 'For phone widths run <span class="path">npm run docs:screens -- --phone</span>.')}</p></div>
</section>
</div>`,
    script: `document.querySelectorAll('.expand').forEach(function (btn) {
  btn.addEventListener('click', function () {
    var frame = btn.closest('.screen').querySelector('.frame');
    btn.textContent = frame.classList.toggle('open') ? 'Collapse' : 'Show full height';
  });
});`,
  });
}

(async () => {
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  let app = null;
  let browser = null;
  try {
    process.stdout.write('starting a throwaway app ... ');
    app = await server.start();
    console.log(`${app.baseUrl} (SQLite, SMS in dev mode)`);

    process.stdout.write('seeding demo games ... ');
    const fx = await fixtures.seed(app.baseUrl);
    await fixtures.verify(app.baseUrl, fx);
    Object.assign(fx, await seedStateFixtures(app.baseUrl, fx));

    // The screenshot server keeps SMS event logging off, so the delivery log would photograph
    // as an empty panel. These two rows show what a host actually sees in it.
    await fixtures.seedSmsEvent({
      gameId: fx.open.gameId, eventId: 'upcoming-game-reminder', phone: fx.JOIN_PHONE,
      dbFile: app.dbFile
    });
    await fixtures.seedSmsEvent({
      gameId: fx.open.gameId, eventId: 'host-player-joined', phone: fx.HOST_PHONE,
      status: 'failed', attempts: 3, error: 'Carrier rejected the message',
      dbFile: app.dbFile
    });
    console.log('3 games plus a game-day and a cancelled-only fixture, shapes verified');

    process.stdout.write('launching headless Chrome ... ');
    browser = await cdp.launch();
    console.log(cdp.findChrome().split('/').pop());

    let screens = buildScreens(fx);
    if (ONLY) {
      screens = screens.filter((s) => s.file.includes(ONLY) || s.of.includes(ONLY));
      console.log(`--only=${ONLY} matched ${screens.length} screen(s)`);
    }

    console.log(`\ncapturing ${screens.length} screens at ${PHONE ? 'phone' : 'desktop'} width:`);
    const taken = [];
    for (const s of screens) {
      const size = SIZE[s.size];
      const p = await browser.newPage({ width: size.w, deviceScaleFactor: size.dsf });
      try {
        await p.goto(app.baseUrl + s.url);
        if (s.act) await s.act(p);
        const buf = await p.screenshot({ quality: size.q });
        const [width, height] = await p.size();
        fs.writeFileSync(path.join(SHOT_DIR, `${s.file}.webp`), buf);
        taken.push({ ...s, base64: buf.toString('base64'), width, height, bytes: buf.length });
        console.log(`  ${s.file.padEnd(26)} ${String(Math.round(buf.length / 1024)).padStart(4)}kb  ${width}x${height}`);
      } finally {
        await p.close();
      }
    }

    const devSends = server.countDevModeSends(app.log());
    const html = buildGallery(taken, { devSends });
    fs.writeFileSync(path.join(OUT_DIR, GALLERY), html);

    const totalKb = Math.round(taken.reduce((a, s) => a + s.bytes, 0) / 1024);
    console.log(`\n  docs/${GALLERY}  ${taken.length} screens, ${totalKb}kb of images inlined`);
    console.log(`  docs/${SHOT_REL}/${' '.repeat(Math.max(0, 22 - SHOT_REL.length))} ${taken.length} .webp files`);
    console.log(`\n  ${devSends} SMS send(s) took the dev-mode branch; none reached Textbelt.`);
    console.log(`\nOpen it with:\n  open docs/${GALLERY}`);
  } finally {
    // Teardown runs even if a capture threw, so a failed run never leaves demo games behind.
    if (browser) await browser.close();
    if (app) await app.stop();
    if (KEEP) {
      console.log('\n--keep-fixtures: demo games left in the local database.');
    } else {
      // Screenshots stay on the shared local database (the browser smoke is the one that gets
      // a throwaway), so the demo games still have to be swept by their marker.
      const removed = await fixtures.cleanup(app?.dbFile);
      console.log(`\ncleaned up ${removed} demo game(s) from the local database.`);
    }
  }
})().catch((e) => {
  console.error('\nFAILED:', e.message);
  process.exit(1);
});
