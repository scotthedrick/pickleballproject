// The Communication tab: announcements, the quick day-of messages, the recipient picker and
// the delivery log.
import { gameData, gameId } from './state.js';
import { request, json } from './api.js';
import { clear } from './dom.js';
import ManageRender from './render.js';
import * as PageUtils from '../page-utils.js';
import * as CentralTime from '../central-time.js';
import { showStatus, showConfirmModal, formatDateForDisplay, formatTime } from './game.js';

// personalityWrapper defaults off because the quick messages below show the host the exact text
// in a confirm modal before sending. The custom announcement has no such preview and always
// opts in - see sendAnnouncement.
async function postAnnouncement(message, recipients, { personalityWrapper = false } = {}) {
    const response = await request(
        `/api/games/${gameId}/announcement-individual`,
        {
            method: 'POST',
            body: { message, recipients, personalityWrapper }
        }
    );

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(data.error || 'Failed to send announcement');
    }
    return data;
}

// The server drops anybody who has left the game since the host ticked them, which otherwise
// shows up only as a recipient count that is quietly one short.
function announcementResultText(data) {
    const sent = `Announcement sent to ${data.recipientCount} ${data.recipientCount === 1 ? 'player' : 'players'}.`;
    const skipped = data.skipped || [];
    if (skipped.length === 0) return sent;

    const names = skipped.map((entry) => entry.player).join(', ');
    return `${sent} ${skipped.length === 1 ? 'One person was' : `${skipped.length} people were`} skipped because they are no longer on this game: ${names}.`;
}

export async function sendAnnouncement() {
    if (!CentralTime.getGameStatus(gameData).canEdit) {
        showStatus('This game has ended, so announcements can no longer be sent.', 'error');
        return;
    }
    
    try {
        const message = document.getElementById('announcementText').value;
        
        if (!message) {
            throw new Error('Please enter a message');
        }
        
        // Get selected recipients
        const recipients = getSelectedRecipients();
        
        if (recipients.length === 0) {
            throw new Error('Please select at least one recipient');
        }
        
        showStatus('Sending announcement...', 'info');

        // The host used to tick a box for this. Now that every player-facing text carries the
        // game's personality, the opening is always on and there is nothing to decide.
        const data = await postAnnouncement(message, recipients, { personalityWrapper: true });
        console.log('Announcement sent:', data);

        // Reset form
        document.getElementById('announcementText').value = '';
        clearAllRecipientSelections();

        // The log below is about what this game has texted, so a send belongs in it now.
        loadDeliveryLog();

        showStatus(announcementResultText(data), data.skipped?.length ? 'info' : 'success');
        
    } catch (error) {
        console.error('Error sending announcement:', error);
        showStatus('Error sending announcement: ' + error.message, 'error');
    }
}

export function quickMessageText(type) {
    if (type === 'reminder') {
        // TIMEZONE FIX: Use proper date formatting
        const formattedDate = formatDateForDisplay(gameData.date);

        return `Reminder: Your pickleball game is on ${formattedDate} at ${formatTime(gameData.time)} — ${gameData.location}. Looking forward to seeing you there!`;
    }

    if (type === 'location') {
        // Repeating the location a player already has is not worth a text. The gate code in the
        // host's private notes is - but only when the host has seen it in the confirmation and
        // chosen to send it.
        const notes = String(gameData.hostNotes || '').trim();
        const base = `Location details for our pickleball game: ${gameData.location}. Game starts at ${formatTime(gameData.time)}.`;
        return notes ? `${base} ${notes}` : base;
    }

    return '';
}

// Confirmed players only. A waitlisted player has no spot yet, so "your game is on Saturday"
// and directions to the court would both be wrong for them.
function confirmedRecipients() {
    return (gameData?.players || [])
        .filter((player) => player.phone && !player.isOrganizer)
        .map((player) => ({
            id: player.id,
            phone: player.phone,
            name: player.name,
            type: 'confirmed'
        }));
}

export function sendQuickMessage(type) {
    if (!CentralTime.getGameStatus(gameData).canEdit) {
        showStatus('This game has ended, so announcements can no longer be sent.', 'error');
        return;
    }

    const message = quickMessageText(type);
    if (!message) return;

    const recipients = confirmedRecipients();
    if (recipients.length === 0) {
        showStatus('None of your confirmed players have a phone number to text.', 'error');
        return;
    }

    const includesNotes = type === 'location' && Boolean(String(gameData.hostNotes || '').trim());
    const audience = `${recipients.length} confirmed ${recipients.length === 1 ? 'player' : 'players'}`;
    const notesWarning = includesNotes
        ? '\n\nThis includes your private host notes.'
        : '';

    showConfirmModal(
        type === 'reminder' ? 'Send Game Reminder' : 'Send Location Details',
        `Text this to ${audience} now?\n\n"${message}"${notesWarning}`,
        async () => {
            try {
                showStatus('Sending...', 'info');
                const data = await postAnnouncement(message, recipients);
                loadDeliveryLog();
                showStatus(
                    `Sent to ${data.recipientCount} ${data.recipientCount === 1 ? 'player' : 'players'}.`,
                    'success'
                );
            } catch (error) {
                console.error('Error sending quick message:', error);
                showStatus('Error sending message: ' + error.message, 'error');
            }
        }
    );
}

// The three audiences a host can reach, in the order they appear on the page. Adding the "out"
// list meant either a third copy of every group/individual sync, or one table - this is the table.
const RECIPIENT_GROUPS = [
    {
        checkboxId: 'sendToPlayers',
        type: 'confirmed',
        // The host is not a recipient of their own announcement.
        players: () => (gameData?.players || []).filter((p) => p.phone && !p.isOrganizer)
    },
    {
        checkboxId: 'sendToWaitlist',
        type: 'waitlist',
        players: () => (gameData?.waitlist || []).filter((p) => p.phone)
    },
    {
        checkboxId: 'sendToOut',
        type: 'out',
        players: () => (gameData?.outPlayers || []).filter((p) => p.phone)
    }
];

function groupCheckbox(group) {
    return document.getElementById(group.checkboxId);
}

export function getSelectedRecipients() {
    const recipients = [];

    // Only the real group toggles count. The old fallback selectors could bind "send to
    // players" to any checked checkbox on the page, including a notification preference
    // toggle that has nothing to do with this announcement.
    RECIPIENT_GROUPS.forEach((group) => {
        if (!groupCheckbox(group)?.checked) return;
        group.players().forEach((player) => {
            recipients.push({
                id: player.id,
                phone: player.phone,
                name: player.name,
                type: group.type
            });
        });
    });

    // Individual picks live inside the recipient list only. Scanning the whole document swept
    // in unrelated checkboxes such as the notification preferences.
    const individualContainer = document.getElementById('playerCheckboxes');
    const playerCheckboxes = individualContainer
        ? individualContainer.querySelectorAll('input[type="checkbox"]:checked')
        : [];

    playerCheckboxes.forEach(checkbox => {
        // Only add if not already included from group selection and has required data
        if (checkbox.dataset?.phone && checkbox.dataset?.name) {
            const existingRecipient = recipients.find(r => r.id === checkbox.value);
            if (!existingRecipient) {
                recipients.push({
                    id: checkbox.value,
                    phone: checkbox.dataset.phone,
                    name: checkbox.dataset.name,
                    type: checkbox.dataset.type || 'individual'
                });
            }
        }
    });
    
    return recipients;
}

// The recipient rows are inputs with the class, not wrappers around one, so the old
// ".player-checkbox input" selectors matched nothing and the group toggles never reached the
// individual rows. Everything here is scoped to the recipient list for the same reason.
function recipientCheckboxes(type) {
    const container = document.getElementById('playerCheckboxes');
    if (!container) return [];
    const selector = type
        ? `.player-checkbox[data-type="${type}"]`
        : '.player-checkbox';
    return Array.from(container.querySelectorAll(selector));
}

function setCheckboxState(checkbox, { checked, indeterminate = false }) {
    if (!checkbox) return;
    checkbox.checked = checked;
    checkbox.indeterminate = indeterminate;
}

// "All Players" is on when every group is on, part-way when some are.
function updateSendToAll() {
    const states = RECIPIENT_GROUPS.map((group) => Boolean(groupCheckbox(group)?.checked));
    setCheckboxState(document.getElementById('sendToAll'), {
        checked: states.every(Boolean),
        indeterminate: !states.every(Boolean) && states.some(Boolean)
    });
}

export function toggleAllPlayers(checked) {
    RECIPIENT_GROUPS.forEach((group) => {
        setCheckboxState(groupCheckbox(group), { checked });
    });
    recipientCheckboxes().forEach((checkbox) => {
        checkbox.checked = checked;
    });
}

export function updateGroupSelections() {
    RECIPIENT_GROUPS.forEach((group) => {
        const checked = Boolean(groupCheckbox(group)?.checked);
        recipientCheckboxes(group.type).forEach((checkbox) => {
            checkbox.checked = checked;
        });
    });
    updateSendToAll();
}

export function updateIndividualSelection() {
    RECIPIENT_GROUPS.forEach((group) => {
        const boxes = recipientCheckboxes(group.type);
        if (boxes.length === 0) return;
        const allChecked = boxes.every((checkbox) => checkbox.checked);
        const anyChecked = boxes.some((checkbox) => checkbox.checked);
        setCheckboxState(groupCheckbox(group), {
            checked: allChecked,
            indeterminate: !allChecked && anyChecked
        });
    });
    updateSendToAll();
}

export function clearAllRecipientSelections() {
    // Nothing selected, so an announcement can never go out to a group the host did not pick.
    setCheckboxState(document.getElementById('sendToAll'), { checked: false });
    RECIPIENT_GROUPS.forEach((group) => {
        setCheckboxState(groupCheckbox(group), { checked: false });
    });
    recipientCheckboxes().forEach((checkbox) => {
        checkbox.checked = false;
    });
}

export function updateGroupCheckboxStyling() {
    // Style the group checkbox containers
    const groupCheckboxes = RECIPIENT_GROUP_IDS.map(
        (id) => document.getElementById(id)?.parentElement
    );


    groupCheckboxes.forEach(container => {
        if (container) {
            // Apply consistent styling to match individual players
            container.style.cssText = `
                display: flex !important;
                flex-direction: row !important;
                align-items: center !important;
                gap: 12px !important;
                padding: 12px 15px !important;
                background: var(--surface) !important;
                border: 2px solid var(--border) !important;
                border-radius: 8px !important;
                transition: all 0.2s ease !important;
                box-shadow: 0 1px 3px color-mix(in srgb, var(--ink) 10%, transparent) !important;
                margin-bottom: 8px !important;
            `;
            
            // Style the checkbox input
            const checkbox = container.querySelector('input[type="checkbox"]');
            if (checkbox) {
                checkbox.style.cssText = `
                    width: 18px !important; 
                    height: 18px !important; 
                    margin: 0 !important; 
                    flex-shrink: 0 !important;
                `;
            }
            
            // Style the label
            const label = container.querySelector('label');
            if (label) {
                label.style.cssText = `
                    margin: 0 !important; 
                    font-weight: 500 !important; 
                    cursor: pointer !important; 
                    flex: 1 !important;
                `;
            }
        }
    });
    
    // Add specific border colors for different groups
    const sendToAll = document.getElementById('sendToAll')?.parentElement;
    if (sendToAll) {
        sendToAll.style.borderLeft = '4px solid var(--brand) !important';
    }

    RECIPIENT_GROUPS.forEach((group) => {
        const row = groupCheckbox(group)?.parentElement;
        if (row) {
            row.style.borderLeft = `4px solid ${RECIPIENT_GROUP_ACCENTS[group.type]} !important`;
        }
    });
}

// One colour per audience, used on both the group rows and the individual rows under them.
const RECIPIENT_GROUP_ACCENTS = {
    confirmed: 'var(--brand)',
    waitlist: 'var(--warning)',
    out: 'var(--danger)'
};

const RECIPIENT_GROUP_IDS = [
    'sendToAll',
    ...RECIPIENT_GROUPS.map((group) => group.checkboxId)
];

export function updatePlayerCheckboxes() {
    const container = document.getElementById('playerCheckboxes');
    if (!container) return;

    // This runs on every roster refresh, so a host who is halfway through picking recipients
    // must get their picks back rather than watching them clear underneath them.
    const firstRender = container.dataset.rendered !== 'true';
    const selectedIds = new Set(
        Array.from(container.querySelectorAll('input[type="checkbox"]:checked'))
            .map((checkbox) => checkbox.value)
    );
    const groupState = {};
    RECIPIENT_GROUP_IDS.forEach((id) => {
        const checkbox = document.getElementById(id);
        groupState[id] = {
            checked: Boolean(checkbox && checkbox.checked),
            indeterminate: Boolean(checkbox && checkbox.indeterminate)
        };
    });

    clear(container);

    RECIPIENT_GROUPS.forEach((group) => {
        group.players().forEach((player) => {
            const checkboxItem = ManageRender.createRecipientOption(
                document,
                player,
                group.type,
                updateIndividualSelection
            );

            // Styling to match group checkboxes
            checkboxItem.style.cssText = `
                display: flex !important;
                flex-direction: row !important;
                align-items: center !important;
                gap: 12px !important;
                padding: 12px 15px !important;
                background: var(--surface) !important;
                border: 2px solid var(--border) !important;
                border-radius: 8px !important;
                border-left: 4px solid ${RECIPIENT_GROUP_ACCENTS[group.type]} !important;
                transition: all 0.2s ease !important;
                box-shadow: 0 1px 3px color-mix(in srgb, var(--ink) 10%, transparent) !important;
                margin-bottom: 8px !important;
                font-size: inherit !important;
                line-height: inherit !important;
            `;

            container.appendChild(checkboxItem);
        });
    });


    // Show section only if there are players with phones
    const individualSection = document.getElementById('individualPlayersSection');
    if (individualSection) {
        const hasPlayers = container.children.length > 0;
        individualSection.style.display = hasPlayers ? 'block' : 'none';
    }
    
    container.dataset.rendered = 'true';

    if (firstRender) {
        // A fresh page starts with the confirmed players as the default audience.
        container.querySelectorAll('input[type="checkbox"]').forEach((checkbox) => {
            checkbox.checked = false;
        });
        RECIPIENT_GROUP_IDS.forEach((id) => {
            const checkbox = document.getElementById(id);
            if (checkbox) {
                checkbox.checked = id === 'sendToPlayers';
                checkbox.indeterminate = false;
            }
        });
        return;
    }

    container.querySelectorAll('input[type="checkbox"]').forEach((checkbox) => {
        checkbox.checked = selectedIds.has(checkbox.value);
    });
    RECIPIENT_GROUP_IDS.forEach((id) => {
        const checkbox = document.getElementById(id);
        if (checkbox) {
            checkbox.checked = groupState[id].checked;
            checkbox.indeterminate = groupState[id].indeterminate;
        }
    });
}



// "I never got the reminder" is a question the host could not answer until now, even though
// every attempt has been recorded all along.
const DELIVERY_STATUS_TEXT = {
    sent: 'Delivered',
    failed: 'Did not send',
    simulated: 'Test mode, not really sent'
};

export async function loadDeliveryLog() {
    const list = document.getElementById('deliveryLogList');
    const status = document.getElementById('deliveryLogStatus');
    const refresh = document.getElementById('refreshDeliveryLog');
    if (!list || !status) return;

    status.classList.remove('error-text');
    status.textContent = 'Loading the delivery log...';
    if (refresh) refresh.disabled = true;

    try {
        const response = await request(`/api/games/${gameId}/sms-events`);
        if (!response.ok) throw new Error(`Server returned ${response.status}`);
        const data = await response.json();
        renderDeliveryLog(data.events || [], data.counts || {});
    } catch (error) {
        console.error('Error loading the delivery log:', error);
        clear(list);
        status.textContent = 'Could not load the delivery log. Try refreshing it.';
        status.classList.add('error-text');
    } finally {
        if (refresh) refresh.disabled = false;
    }
}

function renderDeliveryLog(events, counts) {
    const list = document.getElementById('deliveryLogList');
    const status = document.getElementById('deliveryLogStatus');
    clear(list);

    if (events.length === 0) {
        status.textContent = 'No texts have gone out for this game yet.';
        return;
    }

    const failed = counts.failed || 0;
    const simulated = counts.simulated || 0;
    const total = `${events.length} ${events.length === 1 ? 'text' : 'texts'}`;
    if (failed) {
        status.textContent = `${total}, ${failed} of which did not go through.`;
    } else if (simulated === events.length) {
        // Only a local or test server records simulated sends, and calling those "delivered"
        // would be a lie the host could act on.
        status.textContent = `${total}, all in test mode. Nothing was really sent.`;
    } else {
        status.textContent = `${total}, all delivered.`;
    }

    events.forEach((event) => {
        const row = document.createElement('div');
        row.className = `delivery-row ${event.status}`;

        const who = document.createElement('div');
        who.className = 'delivery-who';
        who.textContent = event.name;

        const what = document.createElement('div');
        what.className = 'delivery-what';
        const when = PageUtils.formatTimeAgo(event.sentAt);
        const parts = [event.event];
        if (when) parts.push(when);
        if (event.attempts > 1) parts.push(`${event.attempts} attempts`);
        what.textContent = parts.join(' · ');

        const outcome = document.createElement('div');
        outcome.className = 'delivery-status';
        outcome.textContent = DELIVERY_STATUS_TEXT[event.status] || event.status;

        row.append(who, what, outcome);

        // The provider's reason is the answer to "why didn't it send?" - a tooltip
        // alone would hide it from every phone, where hosts actually read this log.
        if (event.status === 'failed' && event.error) {
            outcome.title = event.error;
            const reason = document.createElement('div');
            reason.className = 'delivery-error';
            reason.textContent = event.error;
            row.appendChild(reason);
        }

        list.appendChild(row);
    });
}

