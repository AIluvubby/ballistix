// ===== ПАЛИТРА ЦВЕТОВ ИГРОКОВ =====
const PLAYER_COLORS = [
    "#e74c3c","#3498db","#2ecc71","#f1c40f",
    "#9b59b6","#1abc9c","#e67e22","#e91e63",
    "#00bcd4","#ff5722","#8bc34a","#ff9800"
];

// ===== FIREBASE CONFIG =====
const FIREBASE_CONFIG = {
    apiKey: "AIzaSyAAncJWjpbkDfCoIrxduNkIjZh75uY8sKU",
    authDomain: "bazza-847be.firebaseapp.com",
    databaseURL: "https://bazza-847be-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "bazza-847be",
    storageBucket: "bazza-847be.firebasestorage.app",
    messagingSenderId: "793637680834",
    appId: "1:793637680834:web:02ac61b84094bc1c9ced5b"
};


// ===== ИНИЦИАЛИЗАЦИЯ FIREBASE =====
let firebaseApp = null;
let db = null;

function initFirebase() {
    if (firebaseApp) return true;
    try {
        firebaseApp = firebase.initializeApp(FIREBASE_CONFIG);
        db = firebase.database();
        return true;
    } catch (e) {
        showMultiError("Ошибка подключения к Firebase");
        console.error(e);
        return false;
    }
}

// ===== СОСТОЯНИЕ =====
let myUid = null;
let myName = "";
let myColor = PLAYER_COLORS[Math.floor(Math.random() * PLAYER_COLORS.length)];
let mySlot = null;
let currentRoomCode = null;
let roomsListener = null;
let roomListener = null;
let lobbyMode = "2v2";

function getMyUid() {
    if (!myUid) {
        myUid = sessionStorage.getItem("ballistix_uid");
        if (!myUid) {
            myUid = Math.random().toString(36).slice(2, 10);
            sessionStorage.setItem("ballistix_uid", myUid);
        }
    }
    return myUid;
}

function genCode() {
    return Math.random().toString(36).slice(2, 6).toUpperCase();
}

function showMultiError(msg) {
    const el = document.getElementById("multi-error");
    if (el) el.textContent = msg;
}

// ===== ОТКРЫТЬ ЭКРАН МУЛЬТИПЛЕЕРА =====
function openMulti() {
    if (!initFirebase()) return;
    // Автоподставляем имя из аккаунта
    if (window.myName) myName = window.myName;
    const nameInput = document.getElementById("input-name");
    if (nameInput && myName) nameInput.value = myName;
    showScreen("screen-multi");
    subscribeToRoomsList();
}

// ===== СПИСОК ЛОББИ =====
function subscribeToRoomsList() {
    if (roomsListener) db.ref("rooms").off("value", roomsListener);

    roomsListener = db.ref("rooms").on("value", snap => {
        const rooms = snap.val() || {};
        renderRoomsList(rooms);
    });
}

function renderRoomsList(rooms) {
    const list = document.getElementById("rooms-list");
    const active = Object.entries(rooms).filter(([, r]) => !r.gameStarted);

    if (active.length === 0) {
        list.innerHTML = `<p class="rooms-empty">Нет активных лобби</p>`;
        return;
    }

    list.innerHTML = active.map(([code, r]) => {
        const slots = r.slots || {};
        const filled = Object.values(slots).filter(Boolean).length;
        const locked = r.password ? "🔒" : "🔓";
        return `
            <div class="room-item" onclick="lobbyJoinFromList('${code}', ${!!r.password})">
                <div class="room-item-left">
                    <span class="room-item-name">${escHtml(r.name || "Лобби")}</span>
                    <span class="room-item-code">${code}</span>
                </div>
                <div class="room-item-right">
                    <span class="room-item-count">${filled}/4</span>
                    <span class="room-item-lock">${locked}</span>
                </div>
            </div>
        `;
    }).join("");
}

// ===== СОЗДАТЬ ЛОББИ =====
async function lobbyCreate() {
    showMultiError("");

    if (!initFirebase()) {
        showMultiError("Firebase не подключён");
        return;
    }

    const inputName = (document.getElementById("input-name").value || "").trim();
    if (inputName) myName = inputName;
    if (!myName) { showMultiError("Введите имя!"); return; }

    const lobbyName = (document.getElementById("input-lobby-name").value || "").trim() || `${myName}'s лобби`;
    const password  = (document.getElementById("input-lobby-pass").value || "").trim();
    const code = genCode();

    try {
        await db.ref("rooms/" + code).set({
            code,
            name: lobbyName,
            password: password || null,
            createdAt: Date.now(),
            gameStarted: false,
            slots: { bottom: null, top: null, left: null, right: null }
        });
        currentRoomCode = code;
        await joinRoom(code);
    } catch (e) {
        console.error("lobbyCreate error:", e);
        showMultiError("Ошибка: " + (e.message || e.code || "проверь правила Firebase"));
    }
}

// ===== ВОЙТИ ИЗ СПИСКА =====
async function lobbyJoinFromList(code, hasPassword) {
    const inputName = (document.getElementById("input-name").value || "").trim();
    if (inputName) myName = inputName;
    if (!myName) { showMultiError("Введите имя!"); return; }
    showMultiError("");

    if (hasPassword) {
        const pass = prompt("Введите пароль комнаты:");
        if (pass === null) return;
        const snap = await db.ref("rooms/" + code + "/password").get();
        if (snap.val() !== pass) { showMultiError("Неверный пароль"); return; }
    }

    currentRoomCode = code;
    await joinRoom(code);
}

// ===== ВОЙТИ В КОМНАТУ =====
async function joinRoom(code) {
    const uid = getMyUid();

    await db.ref(`rooms/${code}/players/${uid}`).set({
        name: myName,
        slot: null,
        joinedAt: Date.now()
    });

    db.ref(`rooms/${code}/players/${uid}`).onDisconnect().remove();
    // Освобождаем слот при отключении — Firebase не может удалить вложенный путь изнутри вложенного set, делаем отдельно
    db.ref(`rooms/${code}/players/${uid}`).onDisconnect().remove();

    mySlot = null;
    lobbyMode = "2v2";
    subscribeToRoom(code);

    // Показываем название лобби
    const snap = await db.ref("rooms/" + code + "/name").get();
    document.getElementById("lobby-title").textContent = snap.val() || "Лобби";

    applyModeColors("2v2");
    showScreen("screen-lobby");

    // Отписываемся от общего списка
    if (roomsListener) { db.ref("rooms").off("value", roomsListener); roomsListener = null; }
}

// ===== ПОДПИСКА НА КОМНАТУ =====
function subscribeToRoom(code) {
    if (roomListener) db.ref("rooms/" + currentRoomCode).off("value", roomListener);

    roomListener = db.ref("rooms/" + code).on("value", snap => {
        if (!snap.exists()) { lobbyLeave(); return; }
        const room = snap.val();

        // Синхронизировать режим от хоста
        if (room.mode && room.mode !== lobbyMode) {
            lobbyMode = room.mode;
            document.querySelectorAll(".btn-mode").forEach(b => b.classList.remove("active"));
            const modeBtn = document.getElementById("mode-btn-" + lobbyMode);
            if (modeBtn) modeBtn.classList.add("active");
            applyModeColors(lobbyMode);
        }

        renderLobby(room);
        if (room.gameStarted) {
            db.ref("rooms/" + code).off("value", roomListener);
            launchMultiGame(room);
        }
    });
}

// ===== ОТРИСОВКА ЛОББИ =====
function renderLobby(room) {
    const slots = room.slots || {};
    const players = room.players || {};

    // Слоты
    ["bottom", "top", "left", "right"].forEach(side => {
        const slotEl = document.getElementById("slot-" + side);
        const playerEl = document.getElementById("slot-player-" + side);
        const occupant = slots[side];

        slotEl.classList.remove("taken", "mine");

        if (occupant) {
            playerEl.textContent = occupant.name;
            if (occupant.uid === getMyUid()) slotEl.classList.add("mine");
            else slotEl.classList.add("taken");
        } else {
            playerEl.textContent = "🤖 Бот";
        }
    });

    // Считаем занятые слоты
    const filled = Object.values(slots).filter(Boolean).length;
    const bots = 4 - filled;

    // Статус
    document.getElementById("lobby-status").textContent =
        filled === 0 ? "Займите место чтобы начать" :
        bots === 0   ? "Все места заняты!" :
                       `${filled} игрок${filled > 1 ? "а" : ""} + ${bots} бот${bots > 1 ? "а" : ""}`;

    // Кнопка старта — всегда доступна
    document.getElementById("btn-start-game").style.display = "block";
}

// ===== ЗАНЯТЬ СЛОТ =====
async function lobbyClaimSlot(side) {
    if (!currentRoomCode || !db) return;
    const uid = getMyUid();

    const snap = await db.ref(`rooms/${currentRoomCode}/slots/${side}`).get();
    const occupant = snap.val();

    // Чужой слот — нельзя
    if (occupant && occupant.uid !== uid) return;

    // Освобождаем старый слот
    if (mySlot && mySlot !== side) {
        await db.ref(`rooms/${currentRoomCode}/slots/${mySlot}`).set(null);
        await db.ref(`rooms/${currentRoomCode}/players/${uid}/slot`).set(null);
    }

    if (mySlot === side) {
        // Повторный клик — покидаем слот
        await db.ref(`rooms/${currentRoomCode}/slots/${side}`).set(null);
        await db.ref(`rooms/${currentRoomCode}/players/${uid}/slot`).set(null);
        db.ref(`rooms/${currentRoomCode}/slots/${side}`).onDisconnect().cancel();
        mySlot = null;
    } else {
        // Занимаем новый — при отключении слот автоматически освобождается
        await db.ref(`rooms/${currentRoomCode}/slots/${side}`).set({ uid, name: myName, color: myColor || PLAYER_COLORS[0] });
        await db.ref(`rooms/${currentRoomCode}/players/${uid}/slot`).set(side);
        db.ref(`rooms/${currentRoomCode}/slots/${side}`).onDisconnect().set(null);
        mySlot = side;
    }
}

// ===== НАЧАТЬ ИГРУ =====
async function lobbyStartGame() {
    if (!currentRoomCode || !db) return;
    await db.ref(`rooms/${currentRoomCode}`).update({
        gameStarted: true,
        hostUid: getMyUid()
    });
}

// ===== СКОПИРОВАТЬ КОД =====
function lobbyCodeCopy() {
    if (!currentRoomCode) return;
    const text = currentRoomCode;
    navigator.clipboard.writeText(text).then(() => {
        const btn = document.querySelector(".btn-copy");
        if (btn) { btn.textContent = "✓ Скопировано!"; setTimeout(() => { btn.textContent = "📋 Скопировать код"; }, 1500); }
    }).catch(() => {
        const inp = document.createElement("input");
        inp.value = text;
        document.body.appendChild(inp);
        inp.select();
        document.execCommand("copy");
        document.body.removeChild(inp);
    });
}

// ===== ВЫЙТИ ИЗ ЛОББИ =====
async function lobbyLeave() {
    if (roomListener) { db.ref("rooms/" + currentRoomCode).off("value", roomListener); roomListener = null; }

    if (db && currentRoomCode) {
        const uid = getMyUid();
        if (mySlot) {
            db.ref(`rooms/${currentRoomCode}/slots/${mySlot}`).onDisconnect().cancel();
            await db.ref(`rooms/${currentRoomCode}/slots/${mySlot}`).set(null);
        }
        db.ref(`rooms/${currentRoomCode}/players/${uid}`).onDisconnect().cancel();
        await db.ref(`rooms/${currentRoomCode}/players/${uid}`).remove();
    }

    mySlot = null;
    currentRoomCode = null;
    showScreen("screen-home");
}

// ===== ЗАПУСК ИГРЫ =====
function launchMultiGame(room) {
    const slots = room.slots || {};
    const uid = getMyUid();
    const isHost = room.hostUid === uid;

    if (!mySlot) {
        Object.entries(slots).forEach(([side, data]) => {
            if (data && data.uid === uid) mySlot = side;
        });
    }

    const SLOT_IDX = { bottom: 0, top: 1, left: 2, right: 3 };
    const myIdx = mySlot ? (SLOT_IDX[mySlot] ?? 0) : 0;

    // Какие слоты заняты реальными игроками
    multiRealSlots = new Set();
    Object.entries(slots).forEach(([side, data]) => {
        if (data) multiRealSlots.add(SLOT_IDX[side]);
    });

    startGame(lobbyMode === "ffa" ? "1v3" : "2v2");

    // ВАЖНО: выставляем после startGame — иначе startGame("1v3") сбросит их в 0/"bottom"
    localPlayerSide = mySlot || "bottom";
    localPlayerIndex = myIdx;

    // Помечаем реальных игроков как не-боты
    Object.entries(slots).forEach(([side, data]) => {
        const i = SLOT_IDX[side];
        if (data && players && players[i]) players[i].isBot = false;
    });

    // Применяем цвета и имена
    ["bottom", "top", "left", "right"].forEach((side, i) => {
        const slotData = slots[side];
        if (slotData && slotData.color && players && players[i]) players[i].color = slotData.color;
        const nameEl = document.querySelector(`#hud-${i} .hud-name`);
        if (nameEl) {
            if (slotData) nameEl.textContent = slotData.uid === uid ? myName : slotData.name;
            else nameEl.textContent = "БОТ";
        }
    });

    // Запускаем синхронизацию
    startMultiSync(currentRoomCode, isHost);
}

// ===== ВЫБОР РЕЖИМА =====
const SLOT_SIDES = ["bottom", "top", "left", "right"];

const MODE_COLORS = {
    "2v2": {
        slotClasses: ["slot-team-a", "slot-team-a", "slot-team-b", "slot-team-b"],
        labelA: "🔵 КОМАНДА А",
        labelB: "🔴 КОМАНДА Б",
        vs: "VS"
    },
    "ffa": {
        slotClasses: ["slot-ffa-0", "slot-ffa-1", "slot-ffa-2", "slot-ffa-3"],
        labelA: "⚡ Свободные",
        labelB: "⚡ Свободные",
        vs: "+"
    }
};

function setLobbyMode(mode) {
    lobbyMode = mode;

    // Кнопки
    document.querySelectorAll(".btn-mode").forEach(b => b.classList.remove("active"));
    document.getElementById("mode-btn-" + mode).classList.add("active");

    applyModeColors(mode);

    // Сохранить в Firebase
    if (currentRoomCode && db) {
        db.ref("rooms/" + currentRoomCode + "/mode").set(mode);
    }
}

function applyModeColors(mode) {
    const cfg = MODE_COLORS[mode] || MODE_COLORS["2v2"];

    document.getElementById("team-label-a").textContent = cfg.labelA;
    document.getElementById("team-label-b").textContent = cfg.labelB;
    document.getElementById("vs-label").textContent = cfg.vs;

    SLOT_SIDES.forEach((side, i) => {
        const el = document.getElementById("slot-" + side);
        // Убрать все цветовые классы
        el.classList.remove("slot-team-a", "slot-team-b", "slot-ffa-0", "slot-ffa-1", "slot-ffa-2", "slot-ffa-3");
        el.classList.add(cfg.slotClasses[i]);
    });
}

// ===== УТИЛИТЫ =====
function escHtml(str) {
    return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
