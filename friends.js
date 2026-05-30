// ===== ДРУЗЬЯ =====

let friendsListener = null;
let requestsListener = null;

function setOnlinePresence() {
    if (!db) return;
    const uid = getMyUid();
    const ref = db.ref(`users/${uid}/online`);
    ref.set(true);
    ref.onDisconnect().set(false);
}

async function showFriends() {
    if (!initFirebase()) return;
    setOnlinePresence();
    showScreen('screen-friends');
    loadFriendsList();
    loadFriendRequests();
}

// ===== ПОИСК =====
async function searchFriend() {
    const input = (document.getElementById('friends-search-input').value || '').trim().toLowerCase();
    if (!input) return;

    const resultsEl = document.getElementById('friends-search-results');
    resultsEl.innerHTML = '<p class="friends-empty">Поиск...</p>';

    const snap = await db.ref('users').get();

    if (!snap.exists()) {
        resultsEl.innerHTML = '<p class="friends-empty">Игрок не найден</p>';
        return;
    }

    const myUid = getMyUid();
    const results = [];
    snap.forEach(c => {
        const u = c.val();
        if (u.uid !== myUid && u.name && u.name.toLowerCase().includes(input)) results.push(u);
    });

    if (results.length === 0) {
        resultsEl.innerHTML = '<p class="friends-empty">Игрок не найден</p>';
        return;
    }

    const friendsSnap  = await db.ref(`users/${myUid}/friends`).get();
    const outgoingSnap = await db.ref(`users/${myUid}/friendRequests/outgoing`).get();
    const friends  = friendsSnap.val()  || {};
    const outgoing = outgoingSnap.val() || {};

    resultsEl.innerHTML = results.map(u => {
        const isFriend  = !!friends[u.uid];
        const isPending = !!outgoing[u.uid];
        const btn = isFriend  ? `<span class="friends-tag">✓ Уже друг</span>`
                  : isPending ? `<span class="friends-tag">Запрос отправлен</span>`
                  : `<button class="btn-friend-add" onclick="sendFriendRequest('${u.uid}','${escHtml(u.name)}')">+ Добавить</button>`;
        return `
            <div class="friend-row">
                <span class="friend-name">${escHtml(u.name)}</span>
                <span class="friend-rating-sm">${u.rating || 1000} MMR</span>
                ${btn}
            </div>`;
    }).join('');
}

// ===== ОТПРАВИТЬ ЗАПРОС =====
async function sendFriendRequest(targetUid, targetName) {
    const uid = getMyUid();
    const myName = window.myName || 'Игрок';
    const ts = Date.now();
    await db.ref(`users/${targetUid}/friendRequests/incoming/${uid}`).set({ name: myName, sentAt: ts });
    await db.ref(`users/${uid}/friendRequests/outgoing/${targetUid}`).set({ name: targetName, sentAt: ts });
    searchFriend();
}

// ===== ПРИНЯТЬ ЗАПРОС =====
async function acceptFriendRequest(senderUid, senderName) {
    const uid = getMyUid();
    const myName = window.myName || 'Игрок';
    await db.ref(`users/${uid}/friends/${senderUid}`).set({ name: senderName, addedAt: Date.now() });
    await db.ref(`users/${senderUid}/friends/${uid}`).set({ name: myName, addedAt: Date.now() });
    await db.ref(`users/${uid}/friendRequests/incoming/${senderUid}`).remove();
    await db.ref(`users/${senderUid}/friendRequests/outgoing/${uid}`).remove();
}

// ===== ОТКЛОНИТЬ ЗАПРОС =====
async function declineFriendRequest(senderUid) {
    const uid = getMyUid();
    await db.ref(`users/${uid}/friendRequests/incoming/${senderUid}`).remove();
    await db.ref(`users/${senderUid}/friendRequests/outgoing/${uid}`).remove();
}

// ===== УДАЛИТЬ ДРУГА =====
async function removeFriend(friendUid) {
    const uid = getMyUid();
    await db.ref(`users/${uid}/friends/${friendUid}`).remove();
    await db.ref(`users/${friendUid}/friends/${uid}`).remove();
}

// ===== СПИСОК ДРУЗЕЙ =====
function loadFriendsList() {
    const uid = getMyUid();
    if (friendsListener) { db.ref(`users/${uid}/friends`).off('value', friendsListener); friendsListener = null; }

    friendsListener = db.ref(`users/${uid}/friends`).on('value', async snap => {
        const friends = snap.val() || {};
        const list = document.getElementById('friends-list');
        const keys = Object.keys(friends);

        if (keys.length === 0) {
            list.innerHTML = '<p class="friends-empty">Друзей пока нет — найди игроков через поиск!</p>';
            return;
        }

        const entries = await Promise.all(keys.map(async fUid => {
            const onlineSnap = await db.ref(`users/${fUid}/online`).get();
            return { uid: fUid, name: friends[fUid].name, online: !!onlineSnap.val() };
        }));

        entries.sort((a, b) => b.online - a.online);

        list.innerHTML = entries.map(f => `
            <div class="friend-row">
                <span class="friend-status-dot ${f.online ? 'online' : 'offline'}"></span>
                <span class="friend-name">${escHtml(f.name)}</span>
                <span class="friend-online-text ${f.online ? 'online' : ''}">${f.online ? 'Онлайн' : 'Офлайн'}</span>
                <button class="btn-friend-remove" onclick="removeFriend('${f.uid}')">✕</button>
            </div>`).join('');
    });
}

// ===== ВХОДЯЩИЕ ЗАПРОСЫ =====
function loadFriendRequests() {
    const uid = getMyUid();
    if (requestsListener) { db.ref(`users/${uid}/friendRequests/incoming`).off('value', requestsListener); requestsListener = null; }

    requestsListener = db.ref(`users/${uid}/friendRequests/incoming`).on('value', snap => {
        const requests = snap.val() || {};
        const el    = document.getElementById('friends-requests');
        const badge = document.getElementById('friends-badge');
        const count = Object.keys(requests).length;

        if (badge) {
            badge.textContent = count > 0 ? count : '';
            badge.style.display = count > 0 ? 'flex' : 'none';
        }

        if (!el) return;
        if (count === 0) { el.innerHTML = ''; return; }

        el.innerHTML = `
            <p class="requests-title">Входящие запросы</p>
            ${Object.entries(requests).map(([sUid, data]) => `
                <div class="friend-row request-row">
                    <span class="friend-name">${escHtml(data.name)}</span>
                    <button class="btn-friend-accept" onclick="acceptFriendRequest('${sUid}','${escHtml(data.name)}')">✓ Принять</button>
                    <button class="btn-friend-decline" onclick="declineFriendRequest('${sUid}')">✕</button>
                </div>`).join('')}`;
    });
}

// ===== БЕЙДЖ НА ГЛАВНОМ ЭКРАНЕ =====
function listenForFriendsBadge() {
    if (!db) return;
    const uid = getMyUid();
    db.ref(`users/${uid}/friendRequests/incoming`).on('value', snap => {
        const badge = document.getElementById('friends-badge');
        const count = snap.exists() ? Object.keys(snap.val() || {}).length : 0;
        if (badge) {
            badge.textContent = count > 0 ? count : '';
            badge.style.display = count > 0 ? 'flex' : 'none';
        }
    });
}
