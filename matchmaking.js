// ===== MATCHMAKING & РЕЙТИНГ =====

const INITIAL_RATING = 1000;
const K_FACTOR       = 32;
const QUEUE_PATH     = 'matchmaking/queue';
const USERS_PATH     = 'users';

let inQueue       = false;
let queueListener = null;
let rankedTeams   = null; // { teamA: [uid,uid], teamB: [uid,uid] }
let userProfile   = null;

// ===== ПРОФИЛЬ =====
async function loadUserProfile() {
    if (!initFirebase()) return;
    const uid = getMyUid();
    const snap = await db.ref(`${USERS_PATH}/${uid}`).get();
    if (snap.exists()) {
        userProfile = snap.val();
    } else {
        userProfile = { uid, name: window.myName || 'Игрок', rating: INITIAL_RATING, wins: 0, losses: 0, gamesPlayed: 0 };
        await db.ref(`${USERS_PATH}/${uid}`).set(userProfile);
    }
    updateRatingDisplay();
}

function updateRatingDisplay() {
    const el = document.getElementById('home-rating');
    if (el && userProfile) el.textContent = `${userProfile.rating} MMR`;
}

// ===== ПОИСК МАТЧА =====
async function joinQueue() {
    if (!initFirebase() || inQueue) return;
    const uid = getMyUid();
    if (!userProfile) await loadUserProfile();

    inQueue = true;
    showScreen('screen-matchmaking');

    const ref = db.ref(`${QUEUE_PATH}/${uid}`);
    await ref.set({ uid, name: window.myName || userProfile.name, rating: userProfile.rating, joinedAt: Date.now(), roomCode: null });
    ref.onDisconnect().remove();

    // Ждём roomCode в своей записи
    ref.on('value', snap => {
        if (!snap.exists() || !inQueue) return;
        const data = snap.val();
        if (data && data.roomCode) {
            ref.off();
            ref.onDisconnect().cancel();
            joinRankedRoom(data.roomCode, data.teamA, data.teamB);
        }
    });

    // Слушаем очередь
    queueListener = db.ref(QUEUE_PATH).on('value', snap => {
        if (!inQueue) return;
        const all = snap.val() || {};
        const players = Object.values(all).filter(p => !p.roomCode).sort((a, b) => a.joinedAt - b.joinedAt);

        document.getElementById('mm-count').textContent = `${players.length} / 4`;
        renderMMPlayers(players);

        if (players.length >= 4 && players[0].uid === uid) {
            tryCreateMatch(players.slice(0, 4));
        }
    });
}

async function tryCreateMatch(players) {
    const uid = getMyUid();
    const lockRef = db.ref('matchmaking/lock');
    try {
        const res = await lockRef.transaction(cur => {
            if (cur && Date.now() - cur.ts < 8000) return;
            return { hostUid: uid, ts: Date.now() };
        });
        if (!res.committed) return;

        const code = Math.random().toString(36).slice(2, 6).toUpperCase();
        const teamA = [players[0].uid, players[1].uid];
        const teamB = [players[2].uid, players[3].uid];

        const slotColors = ["#00cfff", "#ff2d55", "#00ff99", "#ffcc00"];
        await db.ref(`rooms/${code}`).set({
            code, name: 'Рейтинговый матч', password: null,
            createdAt: Date.now(), gameStarted: false, ranked: true,
            mode: '2v2', teamA, teamB,
            slots: {
                bottom: { uid: players[0].uid, name: players[0].name, color: slotColors[0] },
                top:    { uid: players[1].uid, name: players[1].name, color: slotColors[1] },
                left:   { uid: players[2].uid, name: players[2].name, color: slotColors[2] },
                right:  { uid: players[3].uid, name: players[3].name, color: slotColors[3] }
            }
        });

        for (const p of players) {
            await db.ref(`${QUEUE_PATH}/${p.uid}`).update({ roomCode: code, teamA, teamB });
        }

        setTimeout(() => lockRef.remove(), 5000);
    } catch (e) { console.error('tryCreateMatch:', e); }
}

function joinRankedRoom(code, teamA, teamB) {
    inQueue = false;
    if (queueListener) { db.ref(QUEUE_PATH).off('value', queueListener); queueListener = null; }

    const uid = getMyUid();
    rankedTeams = { teamA, teamB };
    currentRoomCode = code;
    mySlot = null;
    lobbyMode = '2v2';

    db.ref(`rooms/${code}/players/${uid}`).set({ name: window.myName, slot: null, joinedAt: Date.now() });
    db.ref(`rooms/${code}/players/${uid}`).onDisconnect().remove();

    // Автоматически занимаем назначенный слот
    const SLOT_ORDER = ['bottom', 'top', 'left', 'right'];
    const allPlayers = [...(teamA || []), ...(teamB || [])];
    const myIdx = allPlayers.indexOf(uid);
    if (myIdx >= 0) {
        const assignedSlot = SLOT_ORDER[myIdx];
        setTimeout(() => lobbyClaimSlot(assignedSlot), 800);
    }

    subscribeToRoom(code);
    db.ref(`rooms/${code}/name`).get().then(s => {
        document.getElementById('lobby-title').textContent = s.val() || 'Рейтинговый матч';
    });

    applyModeColors('2v2');
    showScreen('screen-lobby');
    db.ref(`${QUEUE_PATH}/${uid}`).remove();

    // Автостарт когда все 4 слота заняты
    db.ref(`rooms/${code}/slots`).on('value', snap => {
        const slots = snap.val() || {};
        const filled = Object.values(slots).filter(Boolean).length;
        if (filled === 4) {
            db.ref(`rooms/${code}/slots`).off();
            setTimeout(() => {
                db.ref(`rooms/${code}`).update({ gameStarted: true, hostUid: uid });
            }, 1500);
        }
    });
}

async function leaveQueue() {
    inQueue = false;
    const uid = getMyUid();
    if (queueListener) { db.ref(QUEUE_PATH).off('value', queueListener); queueListener = null; }
    if (db) {
        db.ref(`${QUEUE_PATH}/${uid}`).onDisconnect().cancel();
        await db.ref(`${QUEUE_PATH}/${uid}`).remove();
    }
    showScreen('screen-home');
}

// ===== UI =====
function renderMMPlayers(players) {
    const el = document.getElementById('mm-players');
    if (!el) return;
    const slots = ['🔵', '🔵', '🔴', '🔴'];
    el.innerHTML = players.slice(0, 4).map((p, i) => `
        <div class="mm-player">
            <span>${slots[i]} ${escHtml(p.name)}</span>
            <span class="mm-player-rating">${p.rating}</span>
        </div>
    `).join('') + Array(Math.max(0, 4 - players.length)).fill('<div class="mm-player mm-empty">Ожидание...</div>').join('');
}

// ===== ELO =====
function calcElo(myRating, oppRating, won) {
    const expected = 1 / (1 + Math.pow(10, (oppRating - myRating) / 400));
    return Math.round(K_FACTOR * ((won ? 1 : 0) - expected));
}

async function updateRatingsAfterGame(winningTeamIdx) {
    if (!rankedTeams || !db) return;
    const { teamA, teamB } = rankedTeams;
    const teamAWon = winningTeamIdx === 0;

    const getAvgRating = async uids => {
        let total = 0;
        for (const uid of uids) {
            const s = await db.ref(`${USERS_PATH}/${uid}/rating`).get();
            total += (s.val() || INITIAL_RATING);
        }
        return total / uids.length;
    };

    const ratingA = await getAvgRating(teamA);
    const ratingB = await getAvgRating(teamB);

    const updateOne = async (uid, won, oppAvg) => {
        const s = await db.ref(`${USERS_PATH}/${uid}`).get();
        const prof = s.val() || { rating: INITIAL_RATING, wins: 0, losses: 0, gamesPlayed: 0 };
        const delta = calcElo(prof.rating, oppAvg, won);
        const newRating = Math.max(100, prof.rating + delta);
        await db.ref(`${USERS_PATH}/${uid}`).update({
            rating: newRating,
            wins: (prof.wins || 0) + (won ? 1 : 0),
            losses: (prof.losses || 0) + (won ? 0 : 1),
            gamesPlayed: (prof.gamesPlayed || 0) + 1
        });
        if (uid === getMyUid()) {
            userProfile = { ...prof, rating: newRating };
            updateRatingDisplay();
            const sign = delta >= 0 ? '+' : '';
            goalMessage = { text: `${sign}${delta} MMR`, color: delta >= 0 ? '#34d399' : '#f87171', alpha: 1, timer: 180 };
        }
    };

    for (const uid of teamA) await updateOne(uid, teamAWon, ratingB);
    for (const uid of teamB) await updateOne(uid, !teamAWon, ratingA);
    rankedTeams = null;
}

// ===== ТАБЛИЦА ЛИДЕРОВ =====
async function showLeaderboard() {
    if (!initFirebase()) return;
    showScreen('screen-leaderboard');
    const list = document.getElementById('lb-list');
    list.innerHTML = '<p class="lb-loading">Загрузка...</p>';

    const snap = await db.ref(USERS_PATH).orderByChild('rating').limitToLast(20).get();
    const users = [];
    snap.forEach(c => users.push(c.val()));
    users.sort((a, b) => (b.rating || 0) - (a.rating || 0));

    const medals = ['🥇', '🥈', '🥉'];
    list.innerHTML = users.length === 0
        ? '<p class="lb-loading">Пока никого нет — будь первым!</p>'
        : users.map((u, i) => `
            <div class="lb-row ${u.uid === getMyUid() ? 'lb-me' : ''}">
                <span class="lb-rank">${medals[i] || `#${i+1}`}</span>
                <span class="lb-name">${escHtml(u.name || 'Игрок')}</span>
                <span class="lb-rating">${u.rating || INITIAL_RATING}</span>
                <span class="lb-record">${u.wins || 0}П / ${u.losses || 0}П</span>
            </div>`).join('');
}
