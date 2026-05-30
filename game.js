const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");

// ===== РАЗМЕРЫ =====
let W, H, ARENA, OFFSET_X, OFFSET_Y;
let tmpCanvas = null, tmpCtx = null;

function resize() {
    W = canvas.width = window.innerWidth;
    H = canvas.height = window.innerHeight;
    ARENA = Math.min(W * 1.0, H * 1.0, 700) - 12;
    OFFSET_X = (W - ARENA) / 2;
    OFFSET_Y = (H - ARENA) / 2;             // центрируем по вертикали
    tmpCanvas = document.createElement('canvas');
    tmpCanvas.width = W; tmpCanvas.height = H;
    tmpCtx = tmpCanvas.getContext('2d');
}

window.addEventListener("resize", () => { resize(); });
resize();

// ===== ЦВЕТА ИГРОКОВ =====
const COLORS = ["#00cfff", "#ff2d55", "#00ff99", "#ffcc00"];
const ZONE_HUES = [210, 345, 140, 38];
const NAMES = ["ТЫ", "БОТ 1", "БОТ 2", "БОТ 3"];

// ===== ВОРОТА - фиксированы по центру каждой стены =====
const GATE_SIZE = 0.70; // ворота — прямой участок стены
const GATE_CENTER = 0.5;
const CORNER_ZONE = (1 - GATE_SIZE) / 2; // 0.15 — радиус скругления углов
const PADDLE_W = GATE_SIZE * 0.264; // -20% от 0.33
const PADDLE_R = PADDLE_W / 2;       // ширина полудиска (нормализованная)
const JOYSTICK_DEPTH = 35;           // глубина эллипса в пикселях (90° = 35px)
const SUPER_ZONE = 33;               // зона суперудара x2
const PADDLE_SPEED = 0.015804; // -20% от 0.019755
const MAX_PUSH     = 0.07;   // макс. выдвижение контроллера вперёд (норм. единицы)
const PUSH_SPEED   = 0.006;  // скорость выдвижения (на кадр)
const PUSH_RETURN  = 0.018;  // скорость возврата (быстрее)
const SNITCH_R     = 0.016;  // радиус снитча (примерно вдвое меньше шара)
const MAGNET_FORCE = 0.06;   // сила притяжения шара к магниту

// ===== СОСТОЯНИЕ =====
let players, ball, gameRunning, animId, ballResetting, ballBoosted;
let wallBounceStreak = 0;
let ballCornerTimer = 0; // сколько кадров шар провёл в угловой зоне
let gameMode = "1v3";
let scores = [0, 0, 0, 0];
let teamScores = [0, 0];
let gameTimeLeft = 180;
let keys = {};
let prevPlayerX = [0.5, 0.5, 0, 1];
let prevPlayerY = [1, 0, 0.5, 0.5];
let neonHue = 0;
let touchPaddlePos = null;  // позиция вдоль стены (0-1)
let touchPushActive = false; // палец сдвинут к центру = выдвижной удар
let touchSuperQueued = false;
let touchSuperFired = false;
let streakMessage = null;
let localPlayerSide = "bottom";
let snitch = null;
let snitchSpawnCountdown = 20; // секунд до появления снитча
let localPlayerIndex = 0;

// ===== МУЛЬТИПЛЕЕР =====
let multiMode = false;
let multiIsHost = false;
let multiRoomCode = null;
let multiRealSlots = new Set();
let _multiDb = null;
let _multiStateTimer = null;
let _multiInputTimer = null;
let _multiBallTarget = null;
let _multiPrevScores = [0, 0, 0, 0];

const SLOT_TO_IDX = { bottom: 0, top: 1, left: 2, right: 3 };
const IDX_TO_SLOT = ['bottom', 'top', 'left', 'right'];

function startMultiSync(roomCode, isHost) {
    multiMode = true;
    multiIsHost = isHost;
    multiRoomCode = roomCode;
    _multiDb = firebase.database();
    const roomRef = _multiDb.ref('rooms/' + roomCode);

    if (isHost) {
        // Хост пишет gameState каждые 50мс
        _multiStateTimer = setInterval(() => {
            if (!gameRunning) return;
            roomRef.child('gs').set({
                b: { x: +ball.x.toFixed(4), y: +ball.y.toFixed(4),
                     vx: +ball.vx.toFixed(5), vy: +ball.vy.toFixed(5),
                     s: +ball.speed.toFixed(5), r: ballResetting ? 1 : 0 },
                p: players.map(p => [+p.x.toFixed(4), +p.y.toFixed(4)]),
                sc: scores, ts: teamScores,
                t: +gameTimeLeft.toFixed(2)
            });
        }, 50);
        // Хост читает инпуты реальных игроков
        roomRef.child('inputs').on('value', snap => {
            if (!snap.exists()) return;
            Object.entries(snap.val() || {}).forEach(([side, pos]) => {
                const idx = SLOT_TO_IDX[side];
                if (idx === undefined || idx === localPlayerIndex) return;
                if (multiRealSlots.has(idx) && players[idx]) {
                    if (pos.x !== undefined) players[idx].x = pos.x;
                    if (pos.y !== undefined) players[idx].y = pos.y;
                }
            });
        });
    } else {
        // Не-хост читает gameState
        roomRef.child('gs').on('value', snap => {
            if (!snap.exists() || !gameRunning) return;
            const gs = snap.val();
            if (!gs || !gs.b) return;
            _multiBallTarget = gs.b;
            ballResetting = gs.b.r === 1;
            if (gs.p) gs.p.forEach((pos, i) => {
                if (i !== localPlayerIndex && players[i]) {
                    players[i].x = pos[0]; players[i].y = pos[1];
                }
            });
            if (gs.sc) {
                gs.sc.forEach((s, i) => {
                    if (s > _multiPrevScores[i]) {
                        goalMessage = { text: `⚽ ГОЛ!`, color: players[i] ? players[i].color : '#fff', alpha: 1, timer: 90 };
                        flashGoal(i);
                    }
                });
                _multiPrevScores = [...gs.sc];
                scores = gs.sc;
            }
            if (gs.ts) teamScores = gs.ts;
            if (gs.t !== undefined) gameTimeLeft = gs.t;
            updateHUD();
        });
    }

    // Все пишут свой инпут каждые 50мс
    _multiInputTimer = setInterval(() => {
        if (!gameRunning || !_multiDb) return;
        const p = players[localPlayerIndex];
        const side = IDX_TO_SLOT[localPlayerIndex];
        const horiz = side === 'bottom' || side === 'top';
        roomRef.child('inputs/' + side).set(horiz ? { x: +p.x.toFixed(4) } : { y: +p.y.toFixed(4) });
    }, 50);
}

function stopMultiSync() {
    if (!multiMode) return;
    multiMode = false;
    if (_multiStateTimer) { clearInterval(_multiStateTimer); _multiStateTimer = null; }
    if (_multiInputTimer) { clearInterval(_multiInputTimer); _multiInputTimer = null; }
    if (_multiDb && multiRoomCode) {
        _multiDb.ref('rooms/' + multiRoomCode + '/gs').off();
        _multiDb.ref('rooms/' + multiRoomCode + '/inputs').off();
        _multiDb.ref('rooms/' + multiRoomCode + '/gs').remove();
        _multiDb.ref('rooms/' + multiRoomCode + '/inputs').remove();
    }
    _multiBallTarget = null;
    _multiPrevScores = [0, 0, 0, 0];
}

const GAME_DURATION = 180; // 3 минуты в секундах
const BALL_INIT_SPEED = 0.006;   // +20%
const BALL_MAX_SPEED = 0.0144;  // -20% от старого 0.018, фиксируется после буста
const BALL_ACCEL = 0.000005;
const SUPER_COOLDOWN = 5; // секунд


function getPaddleScale(p) { return 1.0; }

function getPaddlePos(p) {
    const push = p.push || 0;
    if (p.side === "bottom") return { x: p.x, y: p.y - push };
    if (p.side === "top")    return { x: p.x, y: p.y + push };
    if (p.side === "left")   return { x: p.x + push, y: p.y };
    if (p.side === "right")  return { x: p.x - push, y: p.y };
    return { x: p.x, y: p.y };
}

// ===== ИНИЦИАЛИЗАЦИЯ =====
function initGame() {
    scores = [0, 0, 0, 0];
    teamScores = [0, 0];
    gameTimeLeft = GAME_DURATION;

    const base = { push: 0, pushCooldown: 0, pushUsed: false, hasMagnet: false, magnetTimer: 0, magnetActive: false, magnetHoldTime: 0 };
    players = [
        { x: 0.5, y: 1.0, vx: 0, vy: 0, side: "bottom", alive: true, isBot: false, color: COLORS[0], superTimer: 0, streakCount: 0, ...base },
        { x: 0.5, y: 0.0, vx: 0, vy: 0, side: "top",    alive: true, isBot: true,  color: COLORS[1], skill: 0.85, superTimer: 0, streakCount: 0, ...base },
        { x: 0.0, y: 0.5, vx: 0, vy: 0, side: "left",   alive: true, isBot: true,  color: COLORS[2], skill: 0.78, superTimer: 0, streakCount: 0, ...base },
        { x: 1.0, y: 0.5, vx: 0, vy: 0, side: "right",  alive: true, isBot: true,  color: COLORS[3], skill: 0.82, superTimer: 0, streakCount: 0, ...base },
    ];
    snitch = null;
    snitchSpawnCountdown = 60;

    if (gameMode === "2v2") {
        players[0].color = players[1].color = "#5B9BD5";
        players[2].color = players[3].color = "#C2475B";
        document.querySelector("#hud-0 .hud-name").textContent = (window.myName || "ТЫ") + " 🔵";
        document.querySelector("#hud-1 .hud-name").textContent = "СОЮЗНИК 🔵";
        document.querySelector("#hud-2 .hud-name").textContent = "ВРАГ 🔴";
        document.querySelector("#hud-3 .hud-name").textContent = "ВРАГ 🔴";
    } else {
        document.querySelector("#hud-0 .hud-name").textContent = window.myName || "ТЫ";
        document.querySelector("#hud-1 .hud-name").textContent = "БОТ 1";
        document.querySelector("#hud-2 .hud-name").textContent = "БОТ 2";
        document.querySelector("#hud-3 .hud-name").textContent = "БОТ 3";
    }

    const angle = Math.random() * Math.PI * 2;
    ball = {
        x: 0.5, y: 0.5,
        vx: Math.cos(angle) * BALL_INIT_SPEED,
        vy: Math.sin(angle) * BALL_INIT_SPEED,
        speed: BALL_INIT_SPEED,
        r: 0.0232, // -20% от 0.029
        trail: [],
        lastTouched: null
    };
    ballResetting = false;
    ballBoosted = false;
    streakMessage = null;

    prevPlayerX = players.map(p => p.x);
    prevPlayerY = players.map(p => p.y);

    updateHUD();
}

// ===== УПРАВЛЕНИЕ =====
document.addEventListener("keydown", e => {
    if (document.activeElement.tagName === "INPUT") return;
    keys[e.key] = true;
    e.preventDefault();
});
document.addEventListener("keyup", e => { keys[e.key] = false; });

// Сенсорное управление — касание двигает клюшку, вход в зону суперудара активирует его
canvas.addEventListener("touchstart", handleTouch, { passive: false });
canvas.addEventListener("touchmove", handleTouch, { passive: false });
canvas.addEventListener("touchend", () => {
    touchPaddlePos = null;
    touchPushActive = false;
    touchSuperFired = false;
}, { passive: false });

function handleTouch(e) {
    e.preventDefault();
    const touch = e.touches[0];
    if (!touch) return;

    const tx = touch.clientX;
    const ty = touch.clientY;
    const PUSH_THRESHOLD = 55; // px вглубь арены чтобы активировать выдвижной удар

    if (localPlayerSide === "bottom") {
        touchPaddlePos = Math.max(0, Math.min(1, (tx - OFFSET_X) / ARENA));
        touchPushActive = (OFFSET_Y + ARENA - ty) > PUSH_THRESHOLD;
    } else if (localPlayerSide === "top") {
        touchPaddlePos = Math.max(0, Math.min(1, (tx - OFFSET_X) / ARENA));
        touchPushActive = (ty - OFFSET_Y) > PUSH_THRESHOLD;
    } else if (localPlayerSide === "left") {
        touchPaddlePos = Math.max(0, Math.min(1, (ty - OFFSET_Y) / ARENA));
        touchPushActive = (tx - OFFSET_X) > PUSH_THRESHOLD;
    } else if (localPlayerSide === "right") {
        touchPaddlePos = Math.max(0, Math.min(1, (ty - OFFSET_Y) / ARENA));
        touchPushActive = (OFFSET_X + ARENA - tx) > PUSH_THRESHOLD;
    }
}

function handleInput(dt = 1) {
    const p = players[localPlayerIndex];
    if (!p || !p.alive) return;

    const spd = PADDLE_SPEED;
    const scaledR = PADDLE_R * getPaddleScale(p);
    const left  = keys["a"] || keys["A"] || keys["ArrowLeft"];
    const right = keys["d"] || keys["D"] || keys["ArrowRight"];
    const pushFwd = keys["w"] || keys["W"] || keys["ArrowUp"] || touchPushActive;

    if (localPlayerSide === "bottom") {
        if (left)  p.x -= spd;
        if (right) p.x += spd;
        if (touchPaddlePos !== null) p.x = touchPaddlePos;
        p.x = Math.max(CORNER_ZONE + scaledR, Math.min(1 - CORNER_ZONE - scaledR, p.x));
    } else if (localPlayerSide === "top") {
        if (left)  p.x += spd;
        if (right) p.x -= spd;
        if (touchPaddlePos !== null) p.x = 1 - touchPaddlePos;
        p.x = Math.max(CORNER_ZONE + scaledR, Math.min(1 - CORNER_ZONE - scaledR, p.x));
    } else if (localPlayerSide === "left") {
        if (left)  p.y -= spd;
        if (right) p.y += spd;
        if (touchPaddlePos !== null) p.y = touchPaddlePos;
        p.y = Math.max(CORNER_ZONE + scaledR, Math.min(1 - CORNER_ZONE - scaledR, p.y));
    } else if (localPlayerSide === "right") {
        if (left)  p.y += spd;
        if (right) p.y -= spd;
        if (touchPaddlePos !== null) p.y = 1 - touchPaddlePos;
        p.y = Math.max(CORNER_ZONE + scaledR, Math.min(1 - CORNER_ZONE - scaledR, p.y));
    }

    // W = выдвинуть контроллер вперёд (3 сек перезарядка)
    if ((p.pushCooldown || 0) > 0) p.pushCooldown -= dt / 60;
    if (pushFwd && (p.pushCooldown || 0) <= 0) {
        p.push = Math.min((p.push || 0) + PUSH_SPEED * dt, MAX_PUSH);
        p.pushUsed = true;
    } else {
        p.push = Math.max(0, (p.push || 0) - PUSH_RETURN * dt);
        if (p.pushUsed && p.push <= 0) {
            p.pushCooldown = 3;
            p.pushUsed = false;
        }
    }

    // Магнит — автоматически тянет шар когда тот в зоне
    if (p.hasMagnet) {
        p.magnetTimer -= dt / 60;
        if (p.magnetTimer <= 0) { p.hasMagnet = false; p.magnetTimer = 0; p.magnetActive = false; }

        const pos = getPaddlePos(p);
        const bpx = (ball.x - pos.x) * ARENA;
        const bpy = (ball.y - pos.y) * ARENA;
        const horiz = p.side === "bottom" || p.side === "top";
        const ex = (horiz ? PADDLE_R * ARENA : JOYSTICK_DEPTH) + SUPER_ZONE;
        const ey = (horiz ? JOYSTICK_DEPTH : PADDLE_R * ARENA) + SUPER_ZONE;
        const inZone = (bpx / ex) ** 2 + (bpy / ey) ** 2 <= 1;
        if (inZone) {
            p.magnetActive = true;
            ball.vx += (pos.x - ball.x) * MAGNET_FORCE * dt;
            ball.vy += (pos.y - ball.y) * MAGNET_FORCE * dt;
        } else {
            p.magnetActive = false;
        }
    }

    if (touchSuperQueued) { touchSuperQueued = false; } // тач-очередь сброс
}

// ===== БОТЫ =====
function updateBots(dt = 1) {
    if (multiMode && !multiIsHost) return;
    players.forEach((p, i) => {
        if (!p.isBot || !p.alive) return;
        if (multiMode && multiRealSlots.has(i)) return;

        const skill = p.skill;
        // Плавное движение — бот обновляет цель редко, с небольшим шумом
        if (!p.targetX) p.targetX = p.x;
        if (!p.targetY) p.targetY = p.y;
        if (Math.random() < 0.08) {
            p.targetX = ball.x + (Math.random() - 0.5) * (1 - skill) * 0.25;
            p.targetY = ball.y + (Math.random() - 0.5) * (1 - skill) * 0.25;
        }

        const spd = PADDLE_SPEED * (0.65 + skill * 0.45);
        // Инерция — плавно тянется к цели
        if (p.side === "top" || p.side === "bottom") {
            p.x += (p.targetX - p.x) * 0.12;
            p.x = Math.max(CORNER_ZONE + PADDLE_R, Math.min(1 - CORNER_ZONE - PADDLE_R, p.x));
        } else {
            p.y += (p.targetY - p.y) * 0.12;
            p.y = Math.max(CORNER_ZONE + PADDLE_R, Math.min(1 - CORNER_ZONE - PADDLE_R, p.y));
        }

        // Выдвижение вперёд — бот тянется к шару когда тот рядом (3 сек перезарядка)
        const bpx = (ball.x - p.x) * ARENA;
        const bpy = (ball.y - p.y) * ARENA;
        const horiz = p.side === "top" || p.side === "bottom";
        const scaledRpx = PADDLE_R * getPaddleScale(p) * ARENA;
        const ex = (horiz ? scaledRpx : JOYSTICK_DEPTH) + SUPER_ZONE * 2.5;
        const ey = (horiz ? JOYSTICK_DEPTH : scaledRpx) + SUPER_ZONE * 2.5;
        const ballNear = (bpx/ex)**2 + (bpy/ey)**2 <= 1;
        if ((p.pushCooldown || 0) > 0) p.pushCooldown -= dt / 60;
        if (ballNear && (p.pushCooldown || 0) <= 0) {
            p.push = Math.min((p.push || 0) + PUSH_SPEED * dt * skill, MAX_PUSH);
            p.pushUsed = true;
        } else {
            p.push = Math.max(0, (p.push || 0) - PUSH_RETURN * dt);
            if (p.pushUsed && p.push <= 0) {
                p.pushCooldown = 3;
                p.pushUsed = false;
            }
        }

        // Суперудар бота
        if (p.superTimer <= 0 && Math.random() < 0.12) {
            const ex2 = (horiz ? scaledRpx : JOYSTICK_DEPTH) + SUPER_ZONE;
            const ey2 = (horiz ? JOYSTICK_DEPTH : scaledRpx) + SUPER_ZONE;
            if ((bpx/ex2)**2 + (bpy/ey2)**2 <= 1) {
                boostBall(p);
                p.superTimer = SUPER_COOLDOWN;
            }
        }
        if (p.superTimer > 0) p.superTimer -= dt / 60;
    });
}

// ===== ФИЗИКА ШАРА =====
function updateBall(dt = 1) {
    if (multiMode && !multiIsHost) {
        // Не-хост: интерполируем к позиции от хоста
        if (_multiBallTarget) {
            ball.x += (_multiBallTarget.x - ball.x) * 0.35;
            ball.y += (_multiBallTarget.y - ball.y) * 0.35;
            ball.vx = _multiBallTarget.vx;
            ball.vy = _multiBallTarget.vy;
            ball.speed = _multiBallTarget.s;
            ball.trail.push({ x: ball.x, y: ball.y });
            if (ball.trail.length > 12) ball.trail.shift();
        }
        return;
    }
    // Ускорение — только если не было суперудара
    if (!ballBoosted) {
        ball.speed = Math.min(ball.speed + BALL_ACCEL * dt, BALL_MAX_SPEED);
    }
    const len = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy);
    if (len > 0) {
        ball.vx = (ball.vx / len) * ball.speed;
        ball.vy = (ball.vy / len) * ball.speed;
    }

    ball.trail.push({ x: ball.x, y: ball.y });
    if (ball.trail.length > 12) ball.trail.shift();

    ball.x += ball.vx * dt;
    ball.y += ball.vy * dt;

    // Углы → клюшки → стены
    checkCorners();
    checkPaddles();
    checkWalls();
}

function checkCorners() {
    const r = ball.r;
    const cz = CORNER_ZONE;
    // Центры дуг смещены ВНУТРЬ арены на cz от каждого угла
    const corners = [
        { x: cz,     y: cz     },
        { x: 1 - cz, y: cz     },
        { x: cz,     y: 1 - cz },
        { x: 1 - cz, y: 1 - cz },
    ];
    corners.forEach(({ x: cx, y: cy }) => {
        // Проверяем только если шар в угловом квадранте этого угла
        const inQ = ((cx < 0.5) ? (ball.x < cx) : (ball.x > cx)) &&
                    ((cy < 0.5) ? (ball.y < cy) : (ball.y > cy));
        if (!inQ) return;

        const dx = ball.x - cx;
        const dy = ball.y - cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist === 0) return;

        // Шар касается стенки когда dist >= cz - ball.r
        const minDist = cz - r;
        if (dist >= minDist) {
            // Выталкиваем шар обратно на поверхность дуги
            ball.x = cx + (dx / dist) * minDist;
            ball.y = cy + (dy / dist) * minDist;
            // Нормаль отражения направлена ВНУТРЬ (от шара к центру дуги)
            const nx = -dx / dist;
            const ny = -dy / dist;
            const dot = ball.vx * nx + ball.vy * ny;
            if (dot < 0) { // шар летит к стенке
                ball.vx -= 2 * dot * nx;
                ball.vy -= 2 * dot * ny;
            }
        }
    });
}

function escapeCorner() {
    wallBounceStreak = 0;
    ballCornerTimer = 0;
    ballBoosted = false;
    ball.speed = BALL_INIT_SPEED;
    // Строго к центру арены — никакого случайного угла
    const angle = Math.atan2(0.5 - ball.y, 0.5 - ball.x);
    ball.vx = Math.cos(angle) * ball.speed;
    ball.vy = Math.sin(angle) * ball.speed;
    // Сдвигаем шар от угла на 10 шагов скорости
    ball.x += ball.vx * 10;
    ball.y += ball.vy * 10;
    ball.x = Math.max(ball.r + 0.01, Math.min(1 - ball.r - 0.01, ball.x));
    ball.y = Math.max(ball.r + 0.01, Math.min(1 - ball.r - 0.01, ball.y));
}

function checkWalls() {
    if (ballResetting) return;
    const r = ball.r;
    const gs = GATE_SIZE / 2;

    // Верхняя стена — нормаль (0,1), отражение: vy → -vy
    if (ball.y - r < 0 && ball.vy < 0) {
        if (ball.x > GATE_CENTER - gs && ball.x < GATE_CENTER + gs && players[1].alive) {
            goalScored(1);
        } else {
            ball.y = r;
            ball.vy = Math.abs(ball.vy); // гарантируем правильный знак
        }
    }

    // Нижняя стена — нормаль (0,-1)
    if (ball.y + r > 1 && ball.vy > 0) {
        if (ball.x > GATE_CENTER - gs && ball.x < GATE_CENTER + gs && players[0].alive) {
            goalScored(0);
        } else {
            ball.y = 1 - r;
            ball.vy = -Math.abs(ball.vy);
        }
    }

    // Левая стена — нормаль (1,0)
    if (ball.x - r < 0 && ball.vx < 0) {
        if (ball.y > GATE_CENTER - gs && ball.y < GATE_CENTER + gs && players[2].alive) {
            goalScored(2);
        } else {
            ball.x = r;
            ball.vx = Math.abs(ball.vx);
        }
    }

    // Правая стена — нормаль (-1,0)
    if (ball.x + r > 1 && ball.vx > 0) {
        if (ball.y > GATE_CENTER - gs && ball.y < GATE_CENTER + gs && players[3].alive) {
            goalScored(3);
        } else {
            ball.x = 1 - r;
            ball.vx = -Math.abs(ball.vx);
        }
    }
}

function checkPaddles() {
    players.forEach(p => {
        if (!p.alive) return;
        const pos = getPaddlePos(p);
        const dx = ball.x - pos.x;
        const dy = ball.y - pos.y;
        const horiz = p.side === "top" || p.side === "bottom";
        const depth = JOYSTICK_DEPTH / ARENA;
        const scaledR = PADDLE_R * getPaddleScale(p);
        const ex = (horiz ? scaledR : depth) + ball.r;
        const ey = (horiz ? depth : scaledR) + ball.r;
        const dist2 = (dx/ex)**2 + (dy/ey)**2;
        if (dist2 <= 1) {
            // Шар должен лететь К клюшке — если уже отлетает, не трогаем
            const movingToward =
                (p.side === "bottom" && ball.vy > 0) ||
                (p.side === "top"    && ball.vy < 0) ||
                (p.side === "left"   && ball.vx < 0) ||
                (p.side === "right"  && ball.vx > 0);
            if (!movingToward) return;

            const pi = players.indexOf(p);
            if (dist2 > 0.0001) {
                const k = 1 / Math.sqrt(dist2);
                ball.x = pos.x + dx * k;
                ball.y = pos.y + dy * k;
            }
            reflectBall(p, pos);
            ball.lastTouched = pi;
            boostBall(p, pos);
            wallBounceStreak = 0;
        }
    });
}

function reflectBall(p, pos) {
    pos = pos || p;
    const speed = ball.speed;
    const MAX_ANGLE = Math.PI * 0.38;
    const i = players.indexOf(p);

    const paddleVX = p.x - prevPlayerX[i];
    const paddleVY = p.y - prevPlayerY[i];

    if (p.side === "bottom" || p.side === "top") {
        if (p.side === "bottom" && ball.vy < 0) return;
        if (p.side === "top" && ball.vy > 0) return;

        const offset = Math.max(-1, Math.min(1, (ball.x - pos.x) / (PADDLE_W * getPaddleScale(p) / 2)));
        const angle = offset * MAX_ANGLE;

        const dirY = p.side === "bottom" ? -1 : 1;
        ball.vx = Math.sin(angle) * speed + paddleVX * 0.6;
        ball.vy = dirY * Math.cos(angle) * speed + paddleVY * 0.6;

    } else {
        if (p.side === "left" && ball.vx > 0) return;
        if (p.side === "right" && ball.vx < 0) return;

        const offset = Math.max(-1, Math.min(1, (ball.y - pos.y) / (PADDLE_W * getPaddleScale(p) / 2)));
        const angle = offset * MAX_ANGLE;

        const dirX = p.side === "left" ? 1 : -1;
        ball.vx = dirX * Math.cos(angle) * speed + paddleVX * 0.6;
        ball.vy = Math.sin(angle) * speed + paddleVY * 0.6;
    }

    const len = Math.sqrt(ball.vx ** 2 + ball.vy ** 2);
    ball.vx = (ball.vx / len) * speed;
    ball.vy = (ball.vy / len) * speed;
}

function savePrevPositions() {
    players.forEach((p, i) => {
        prevPlayerX[i] = p.x;
        prevPlayerY[i] = p.y;
    });
}

function boostBall(p, pos) {
    // Сохраняем направление от reflectBall, только масштабируем скорость
    const newSpeed = ballBoosted ? ball.speed : BALL_MAX_SPEED;
    const len = Math.sqrt(ball.vx ** 2 + ball.vy ** 2);
    if (len > 0) {
        ball.vx = (ball.vx / len) * newSpeed;
        ball.vy = (ball.vy / len) * newSpeed;
    }
    ball.speed = newSpeed;
    ballBoosted = true;
}

// ===== ГОЛ =====
let goalMessage = null;

function goalScored(playerIndex) {
    const p = players[playerIndex];

    if (gameMode === "2v2") {
        const concedingTeam = playerIndex <= 1 ? 0 : 1;
        const scoringTeam = 1 - concedingTeam;
        teamScores[scoringTeam]++;
    } else {
        if (ball.lastTouched !== null && ball.lastTouched !== playerIndex) {
            scores[ball.lastTouched]++;
        }
    }
    ball.lastTouched = null;
    updateHUD();

    checkStreak(playerIndex);

    const name = playerIndex === 0 ? "ТЕБЕ" : NAMES[playerIndex].replace("БОТ", "БОТУ");
    goalMessage = { text: `⚽ ГОЛ — ${name}!`, color: p.color, alpha: 1, timer: 90 };
    flashGoal(playerIndex);

    ballResetting = true;
    wallBounceStreak = 0;
    ball.vx = 0; ball.vy = 0;
    ball.x = 0.5; ball.y = 0.5;

    setTimeout(() => {
        if (!gameRunning) return;
        const angle = Math.random() * Math.PI * 2;
        ball.speed = BALL_INIT_SPEED;
        ball.vx = Math.cos(angle) * ball.speed;
        ball.vy = Math.sin(angle) * ball.speed;
        ball.trail = [];
        ballBoosted = false;
        ballResetting = false;
    }, 1200);
}

function checkStreak(playerIndex) {
    if (gameMode === "2v2") {
        const concedingTeam = playerIndex <= 1 ? 0 : 1;
        const scoringTeam = 1 - concedingTeam;
        const conceding = concedingTeam === 0 ? [players[0], players[1]] : [players[2], players[3]];
        const scoring   = scoringTeam   === 0 ? [players[0], players[1]] : [players[2], players[3]];

        conceding.forEach(p => { p.streakCount = 0; });
        scoring.forEach(p => { p.streakCount++; });

        if (scoring[0].streakCount >= 3) {
            scoring.forEach(p => { p.streakCount = 0; });
            awardBonusLife(scoringTeam);
        }
    } else {
        if (playerIndex === 0) {
            // Бот забил — у игрока сбрасываем серию
            players[0].streakCount = 0;
        } else {
            // Игрок забил — у него +1 звезда, у бота сброс
            players[playerIndex].streakCount = 0;
            players[0].streakCount++;
            if (players[0].streakCount >= 3) {
                players[0].streakCount = 0;
                awardBonusLife("player");
            }
        }
    }
}

function awardBonusLife(scorer) {
    let text;
    if (gameMode === "2v2") {
        text = scorer === 0 ? "🔵 ХЕТ-ТРИК! 🔥" : "🔴 ХЕТ-ТРИК! 🔥";
    } else {
        text = "⚡ ХЕТ-ТРИК! 🔥";
    }
    streakMessage = { text, alpha: 1, timer: 140 };
}

function flashGoal(index) {
    const hud = document.getElementById(`hud-${index}`);
    hud.style.background = "rgba(255,50,50,0.6)";
    hud.style.transform = "scale(1.1)";
    setTimeout(() => {
        hud.style.background = "";
        hud.style.transform = "";
    }, 500);
}

function drawGoalMessage() {
    if (!goalMessage || goalMessage.timer <= 0) return;

    goalMessage.timer--;
    goalMessage.alpha = goalMessage.timer / 90;

    const size = Math.min(W, H) * 0.07;
    ctx.save();
    ctx.globalAlpha = goalMessage.alpha;
    ctx.font = `900 ${size}px 'Segoe UI'`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    // Тень
    ctx.shadowColor = goalMessage.color;
    ctx.shadowBlur = 40;
    ctx.fillStyle = goalMessage.color;
    ctx.fillText(goalMessage.text, W / 2, H / 2);

    ctx.restore();
}

function checkWinner() {
    if (gameMode === "2v2") {
        const teamAAlive = players[0].alive || players[1].alive;
        const teamBAlive = players[2].alive || players[3].alive;
        if (!teamAAlive && !teamBAlive) endGame(null);
        else if (!teamBAlive) endGame({ team: 0 });
        else if (!teamAAlive) endGame({ team: 1 });
    } else {
        const alive = players.filter(p => p.alive);
        if (alive.length === 1) endGame(alive[0]);
        else if (alive.length === 0) endGame(null);
    }
}

function endGameByTimer() {
    gameRunning = false;
    cancelAnimationFrame(animId);
    stopMultiSync();

    const emoji = document.getElementById("end-emoji");
    const title = document.getElementById("end-title");
    const sub = document.getElementById("end-subtitle");

    if (gameMode === "2v2") {
        const [a, b] = teamScores;
        if (a > b) {
            emoji.textContent = "🏆"; title.textContent = "ПОБЕДА!";
            sub.textContent = `Ваша команда: ${a}:${b} 🔵`;
            if (typeof updateRatingsAfterGame === 'function' && typeof rankedTeams !== 'undefined' && rankedTeams) updateRatingsAfterGame(0);
        } else if (b > a) {
            emoji.textContent = "💔"; title.textContent = "ПОРАЖЕНИЕ";
            sub.textContent = `Противники: ${b}:${a} 🔴`;
            if (typeof updateRatingsAfterGame === 'function' && typeof rankedTeams !== 'undefined' && rankedTeams) updateRatingsAfterGame(1);
        } else {
            emoji.textContent = "🤝"; title.textContent = "НИЧЬЯ!";
            sub.textContent = `${a}:${b}`;
        }
    } else {
        const maxScore = Math.max(...scores);
        const topIdxs = scores.reduce((acc, s, i) => s === maxScore ? [...acc, i] : acc, []);
        if (topIdxs.length > 1) {
            emoji.textContent = "🤝"; title.textContent = "НИЧЬЯ!";
            sub.textContent = `Счёт: ${scores.join(' : ')}`;
        } else if (topIdxs[0] === 0) {
            emoji.textContent = "🏆"; title.textContent = "ПОБЕДА!";
            sub.textContent = `Ты забил больше всех: ${maxScore} голов!`;
        } else {
            emoji.textContent = "💔"; title.textContent = "ПОРАЖЕНИЕ";
            sub.textContent = `${NAMES[topIdxs[0]]} победил: ${maxScore} голов`;
        }
    }

    showScreen("screen-end");
}

function endGame(winner) {
    endGameByTimer();
}

// ===== HUD =====
function updateHUD() {
    players.forEach((p, i) => {
        const el = document.getElementById(`lives-${i}`);
        const hudEl = document.getElementById(`hud-${i}`);
        hudEl.style.opacity = "1";
        if (gameMode === "2v2") {
            const teamIdx = i <= 1 ? 0 : 1;
            el.textContent = `⚽ ${teamScores[teamIdx]}`;
        } else {
            el.textContent = `⚽ ${scores[i]}`;
        }
    });
}

// ===== ПЕРСПЕКТИВА =====
function applyPerspective() {
    if (localPlayerSide === "bottom") return;
    const cx = OFFSET_X + ARENA / 2;
    const cy = OFFSET_Y + ARENA / 2;
    ctx.translate(cx, cy);
    if (localPlayerSide === "top")   ctx.rotate(Math.PI);
    if (localPlayerSide === "left")  ctx.rotate(-Math.PI / 2);
    if (localPlayerSide === "right") ctx.rotate(Math.PI / 2);
    ctx.translate(-cx, -cy);
}

// ===== ФОН АРЕНЫ =====
const arenaImg = new Image();
arenaImg.src = './arena.png';

function drawArenaBackground() {
    const ax = OFFSET_X, ay = OFFSET_Y, sz = ARENA;

    ctx.save();
    arenaRoundedRectPath();
    ctx.clip();

    if (arenaImg.complete && arenaImg.naturalWidth > 0) {
        const iw = arenaImg.naturalWidth, ih = arenaImg.naturalHeight;
        const scale = Math.max(sz / iw, sz / ih);
        const dw = iw * scale, dh = ih * scale;
        const dx = ax + (sz - dw) / 2;
        const dy = ay + (sz - dh) / 2;

        ctx.save();
        ctx.globalAlpha = 0.5;
        ctx.drawImage(arenaImg, dx, dy, dw, dh);
        ctx.globalAlpha = 1;

        // Виньетка
        const vig = ctx.createRadialGradient(ax+sz/2, ay+sz/2, sz*0.25, ax+sz/2, ay+sz/2, sz*0.72);
        vig.addColorStop(0, "rgba(0,0,0,0)");
        vig.addColorStop(1, "rgba(0,0,0,0.5)");
        ctx.fillStyle = vig;
        ctx.fillRect(ax, ay, sz, sz);
        ctx.restore();
    } else {
        ctx.fillStyle = "#0f0c1d";
        ctx.fillRect(ax, ay, sz, sz);
    }

    ctx.restore(); // снимаем клип скруглённого прямоугольника
}

// ===== РЕНДЕР =====
function draw() {
    neonHue = (neonHue + 0.5) % 60; // cycling только в тёплом диапазоне 0-60°
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    applyPerspective();

    // Фон арены — анимированное небо + трава
    drawArenaBackground();

    // Центральный круг
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(OFFSET_X + ARENA / 2, OFFSET_Y + ARENA / 2, ARENA * 0.2, 0, Math.PI * 2);
    ctx.stroke();

    // Угловые блоки
    drawCorners();

    // Ворота
    drawGates();

    // Ракетки + зоны суперудара
    drawPaddles();

    // След шара
    drawBallTrail();

    // Шар
    drawBall();

    // Снитч
    drawSnitch();

    // Луч магнита
    drawMagnetAura();

    // Сообщение о голе
    drawGoalMessage();

    // Индикатор супер удара
    drawSuperIndicator();

    // Хет-трик бонус
    drawStreakMessage();

    ctx.restore();

    // Таймер и счёт — поверх, без перспективы
    drawTimer();
    drawScores();
}

function arenaRoundedRectPath() {
    const r = CORNER_ZONE * ARENA;
    const x = OFFSET_X, y = OFFSET_Y, s = ARENA;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + s - r, y);
    ctx.arc(x + s - r, y + r, r, -Math.PI / 2, 0);
    ctx.lineTo(x + s, y + s - r);
    ctx.arc(x + s - r, y + s - r, r, 0, Math.PI / 2);
    ctx.lineTo(x + r, y + s);
    ctx.arc(x + r, y + s - r, r, Math.PI / 2, Math.PI);
    ctx.lineTo(x, y + r);
    ctx.arc(x + r, y + r, r, Math.PI, 3 * Math.PI / 2);
    ctx.closePath();
}

function drawCorners() {
    // Рамка скруглённой арены
    ctx.save();
    ctx.strokeStyle = "rgba(255,160,60,0.7)";
    ctx.lineWidth = 3;
    ctx.shadowColor = "rgba(255,140,40,0.5)";
    ctx.shadowBlur = 8;
    arenaRoundedRectPath();
    ctx.stroke();
    ctx.restore();
}

function drawGates() {
    const gs = GATE_SIZE * ARENA;
    const gc = GATE_CENTER * ARENA;
    const postSize = 8;
    const postDepth = 18;

    players.forEach((p, i) => {
        if (!p.alive) return;

        ctx.save();
        ctx.strokeStyle = p.color;
        ctx.fillStyle = p.color;

        const g1 = gc - gs / 2;
        const g2 = gc + gs / 2;

        if (p.side === "bottom") {
            const y = OFFSET_Y + ARENA;
            // Подсветка зоны ворот
            ctx.globalAlpha = 0.08;
            ctx.fillRect(OFFSET_X + g1, y - postDepth, gs, postDepth);
            // Линия ворот
            ctx.globalAlpha = 0.9;
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.moveTo(OFFSET_X + g1, y);
            ctx.lineTo(OFFSET_X + g2, y);
            ctx.stroke();
            // Левая стойка
            ctx.fillRect(OFFSET_X + g1 - postSize/2, y - postDepth, postSize, postDepth);
            // Правая стойка
            ctx.fillRect(OFFSET_X + g2 - postSize/2, y - postDepth, postSize, postDepth);

        } else if (p.side === "top") {
            const y = OFFSET_Y;
            ctx.globalAlpha = 0.08;
            ctx.fillRect(OFFSET_X + g1, y, gs, postDepth);
            ctx.globalAlpha = 0.9;
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.moveTo(OFFSET_X + g1, y);
            ctx.lineTo(OFFSET_X + g2, y);
            ctx.stroke();
            ctx.fillRect(OFFSET_X + g1 - postSize/2, y, postSize, postDepth);
            ctx.fillRect(OFFSET_X + g2 - postSize/2, y, postSize, postDepth);

        } else if (p.side === "left") {
            const x = OFFSET_X;
            ctx.globalAlpha = 0.08;
            ctx.fillRect(x, OFFSET_Y + g1, postDepth, gs);
            ctx.globalAlpha = 0.9;
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.moveTo(x, OFFSET_Y + g1);
            ctx.lineTo(x, OFFSET_Y + g2);
            ctx.stroke();
            ctx.fillRect(x, OFFSET_Y + g1 - postSize/2, postDepth, postSize);
            ctx.fillRect(x, OFFSET_Y + g2 - postSize/2, postDepth, postSize);

        } else if (p.side === "right") {
            const x = OFFSET_X + ARENA;
            ctx.globalAlpha = 0.08;
            ctx.fillRect(x - postDepth, OFFSET_Y + g1, postDepth, gs);
            ctx.globalAlpha = 0.9;
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.moveTo(x, OFFSET_Y + g1);
            ctx.lineTo(x, OFFSET_Y + g2);
            ctx.stroke();
            ctx.fillRect(x - postDepth, OFFSET_Y + g1 - postSize/2, postDepth, postSize);
            ctx.fillRect(x - postDepth, OFFSET_Y + g2 - postSize/2, postDepth, postSize);
        }

        ctx.restore();
    });
}

function drawZoneEllipse(c, p, cx, cy, zW, zD) {
    if (p.side === "bottom") c.ellipse(cx, cy, zW, zD, 0, Math.PI, 2*Math.PI);
    if (p.side === "top")    c.ellipse(cx, cy, zW, zD, 0, 0, Math.PI);
    if (p.side === "left")   c.ellipse(cx, cy, zD, zW, 0, 3*Math.PI/2, Math.PI/2);
    if (p.side === "right")  c.ellipse(cx, cy, zD, zW, 0, Math.PI/2, 3*Math.PI/2);
}

function drawZoneIntersections(rD) {
    if (!tmpCanvas) return;
    const alive = players.filter(p => p.alive);
    for (let i = 0; i < alive.length; i++) {
        for (let j = i + 1; j < alive.length; j++) {
            const pi = alive[i], pj = alive[j];
            tmpCtx.clearRect(0, 0, W, H);
            tmpCtx.globalCompositeOperation = 'source-over';

            const rWi = PADDLE_R * ARENA * getPaddleScale(pi);
            tmpCtx.fillStyle = 'white';
            tmpCtx.beginPath();
            drawZoneEllipse(tmpCtx, pi, OFFSET_X + pi.x * ARENA, OFFSET_Y + pi.y * ARENA, rWi + SUPER_ZONE, rD + SUPER_ZONE);
            tmpCtx.closePath();
            tmpCtx.fill();

            tmpCtx.globalCompositeOperation = 'destination-in';
            const rWj = PADDLE_R * ARENA * getPaddleScale(pj);
            tmpCtx.fillStyle = 'white';
            tmpCtx.beginPath();
            drawZoneEllipse(tmpCtx, pj, OFFSET_X + pj.x * ARENA, OFFSET_Y + pj.y * ARENA, rWj + SUPER_ZONE, rD + SUPER_ZONE);
            tmpCtx.closePath();
            tmpCtx.fill();

            tmpCtx.globalCompositeOperation = 'source-atop';
            tmpCtx.fillStyle = `hsla(${neonHue}, 55%, 55%, 0.28)`;
            tmpCtx.fillRect(0, 0, W, H);

            ctx.drawImage(tmpCanvas, 0, 0);
        }
    }
}

function drawPaddles() {
    const rD = JOYSTICK_DEPTH;

    // Проход 1: статичные заливки зон (тёплые, фиксированные оттенки)
    players.forEach((p, i) => {
        if (!p.alive) return;
        const rW = PADDLE_R * ARENA * getPaddleScale(p);
        const cx = OFFSET_X + p.x * ARENA;
        const cy = OFFSET_Y + p.y * ARENA;
        const zW = rW + SUPER_ZONE, zD = rD + SUPER_ZONE;
        ctx.save();
        ctx.fillStyle = `hsla(${ZONE_HUES[i]}, 55%, 45%, 0.10)`;
        ctx.beginPath();
        drawZoneEllipse(ctx, p, cx, cy, zW, zD);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
    });

    // Проход 2: пересечения — cycling тёплый цвет через offscreen canvas
    drawZoneIntersections(rD);

    // Проход 3: клюшки в выдвинутой позиции (без линии зоны)
    players.forEach((p) => {
        if (!p.alive) return;
        const rW = PADDLE_R * ARENA * getPaddleScale(p);
        const pos = getPaddlePos(p);
        const cx = OFFSET_X + pos.x * ARENA;
        const cy = OFFSET_Y + pos.y * ARENA;
        const push = p.push || 0;
        const isPushing = push > 0.005;

        ctx.save();
        ctx.shadowColor = isPushing ? "#ffffff" : p.color;
        ctx.shadowBlur = isPushing ? 52 : 32;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        if (p.side === "bottom") ctx.ellipse(cx, cy, rW, rD, 0, Math.PI, 2*Math.PI);
        if (p.side === "top")    ctx.ellipse(cx, cy, rW, rD, 0, 0, Math.PI);
        if (p.side === "left")   ctx.ellipse(cx, cy, rD, rW, 0, 3*Math.PI/2, Math.PI/2);
        if (p.side === "right")  ctx.ellipse(cx, cy, rD, rW, 0, Math.PI/2, 3*Math.PI/2);
        ctx.closePath();
        ctx.fill();
        // Блик
        ctx.shadowBlur = 0;
        ctx.strokeStyle = isPushing ? "rgba(255,255,255,0.92)" : "rgba(255,255,255,0.55)";
        ctx.lineWidth = isPushing ? 3.5 : 2;
        ctx.beginPath();
        if (p.side === "bottom") ctx.ellipse(cx, cy, rW * 0.75, rD * 0.55, 0, Math.PI, 2*Math.PI);
        if (p.side === "top")    ctx.ellipse(cx, cy, rW * 0.75, rD * 0.55, 0, 0, Math.PI);
        if (p.side === "left")   ctx.ellipse(cx, cy, rD * 0.55, rW * 0.75, 0, 3*Math.PI/2, Math.PI/2);
        if (p.side === "right")  ctx.ellipse(cx, cy, rD * 0.55, rW * 0.75, 0, Math.PI/2, 3*Math.PI/2);
        ctx.stroke();
        ctx.restore();

        // Зона магнита — такой же размер как зона суперудара
        if (p.hasMagnet) {
            const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 200);
            const zW = rW + SUPER_ZONE;
            const zD = rD + SUPER_ZONE;
            ctx.save();
            ctx.strokeStyle = `rgba(255,215,0,${0.45 + pulse * 0.35})`;
            ctx.shadowColor = "#ffd700";
            ctx.shadowBlur = 14 + pulse * 12;
            ctx.lineWidth = 2;
            ctx.setLineDash([7, 5]);
            ctx.beginPath();
            drawZoneEllipse(ctx, p, cx, cy, zW, zD);
            ctx.closePath();
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.restore();
        }
    });
}

function drawBallTrail() {
    ball.trail.forEach((pos, i) => {
        const alpha = i / ball.trail.length * 0.4;
        const r = ball.r * ARENA * (i / ball.trail.length) * 0.8;
        ctx.globalAlpha = alpha;
        ctx.fillStyle = "#d8cfc8";
        ctx.beginPath();
        ctx.arc(OFFSET_X + pos.x * ARENA, OFFSET_Y + pos.y * ARENA, r, 0, Math.PI * 2);
        ctx.fill();
    });
    ctx.globalAlpha = 1;
}

function drawBall() {
    const bx = OFFSET_X + ball.x * ARENA;
    const by = OFFSET_Y + ball.y * ARENA;
    const br = ball.r * ARENA;

    ctx.save();
    // Белый шар
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(bx, by, br, 0, Math.PI * 2);
    ctx.fill();
    // Чёрный контур — 10% от радиуса
    ctx.strokeStyle = "#000000";
    ctx.lineWidth = br * 0.1;
    ctx.beginPath();
    ctx.arc(bx, by, br, 0, Math.PI * 2);
    ctx.stroke();
    // Блик
    ctx.fillStyle = "rgba(255,255,255,0.6)";
    ctx.beginPath();
    ctx.arc(bx - br * 0.3, by - br * 0.3, br * 0.32, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
}

// ===== СНИТЧ (МУХА) =====
function updateSnitch(dt) {
    if (!snitch) return;
    snitch.flutter = (snitch.flutter || 0) + 0.28 * dt;
    snitch.dirTimer = (snitch.dirTimer || 0) - dt;
    if (snitch.dirTimer <= 0) {
        const angle = Math.random() * Math.PI * 2;
        const speed = 0.007 + Math.random() * 0.009;
        snitch.vx = Math.cos(angle) * speed;
        snitch.vy = Math.sin(angle) * speed;
        snitch.dirTimer = 25 + Math.random() * 55;
    }
    snitch.x += snitch.vx * dt;
    snitch.y += snitch.vy * dt;
    const r = snitch.r;
    if (snitch.x - r < 0.04) { snitch.x = 0.04 + r; snitch.vx = Math.abs(snitch.vx); }
    if (snitch.x + r > 0.96) { snitch.x = 0.96 - r; snitch.vx = -Math.abs(snitch.vx); }
    if (snitch.y - r < 0.04) { snitch.y = 0.04 + r; snitch.vy = Math.abs(snitch.vy); }
    if (snitch.y + r > 0.96) { snitch.y = 0.96 - r; snitch.vy = -Math.abs(snitch.vy); }
}

function checkSnitchCollision() {
    if (!snitch) return;
    const dx = ball.x - snitch.x;
    const dy = ball.y - snitch.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < ball.r + snitch.r) {
        const pi = ball.lastTouched;
        if (pi !== null && players[pi] && players[pi].alive) {
            const p = players[pi];
            p.hasMagnet = true;
            p.magnetTimer = 30;
            p.magnetActive = false;
            const who = (pi === localPlayerIndex) ? "ТЫ ПОЙМАЛ" : (NAMES[pi] + " ПОЙМАЛ");
            goalMessage = { text: `✨ ${who} МУХУ!`, color: "#ffd700", alpha: 1, timer: 100 };
        } else {
            goalMessage = { text: `✨ МУХА УЛЕТЕЛА!`, color: "#ffd700", alpha: 1, timer: 100 };
        }
        snitch = null;
        snitchSpawnCountdown = 60;
    }
}

function drawSnitch() {
    if (!snitch) return;
    const sx = OFFSET_X + snitch.x * ARENA;
    const sy = OFFSET_Y + snitch.y * ARENA;
    const sr = snitch.r * ARENA;
    const flutter = Math.sin(snitch.flutter || 0);

    ctx.save();
    // Тело
    ctx.shadowColor = "#ffd700";
    ctx.shadowBlur = 22;
    ctx.fillStyle = "#ffd700";
    ctx.beginPath();
    ctx.arc(sx, sy, sr, 0, Math.PI * 2);
    ctx.fill();
    // Блик
    ctx.fillStyle = "rgba(255,255,255,0.65)";
    ctx.beginPath();
    ctx.arc(sx - sr * 0.3, sy - sr * 0.35, sr * 0.3, 0, Math.PI * 2);
    ctx.fill();
    // Крылья
    ctx.shadowBlur = 10;
    ctx.globalAlpha = 0.72;
    ctx.fillStyle = "rgba(190,225,255,0.88)";
    const wSpan = sr * 2.6;
    const wH = sr * 0.95;
    const fOff = flutter * sr * 0.4;
    ctx.beginPath();
    ctx.ellipse(sx - wSpan * 0.62, sy - fOff, wSpan * 0.52, wH, -0.25, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(sx + wSpan * 0.62, sy - fOff, wSpan * 0.52, wH, 0.25, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
}

function drawMagnetAura() {
    players.forEach((p, i) => {
        if (!p.alive || !p.hasMagnet) return;
        if (!p.magnetActive) return;
        // Луч притяжения от клюшки к шару
        const pos = getPaddlePos(p);
        const px = OFFSET_X + pos.x * ARENA;
        const py = OFFSET_Y + pos.y * ARENA;
        const bx = OFFSET_X + ball.x * ARENA;
        const by = OFFSET_Y + ball.y * ARENA;
        const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 80);
        ctx.save();
        ctx.setLineDash([6, 5]);
        ctx.strokeStyle = `rgba(255,215,0,${0.4 + pulse * 0.4})`;
        ctx.lineWidth = 2;
        ctx.shadowColor = "#ffd700";
        ctx.shadowBlur = 10;
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(bx, by);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
    });
}

function drawScores() {
    const pad = 10;
    const ax = OFFSET_X, ay = OFFSET_Y, sz = ARENA;
    const mid = sz / 2;
    const fontSize = Math.min(W, H) * 0.038;

    const NAMES_HUD = ["ТЫ", "БОТ 1", "БОТ 2", "БОТ 3"];

    // Позиции внутри арены у краёв, чтобы не вылетать за экран
    const layout = [
        { cx: ax + mid,      cy: ay + sz - pad,    align: "center", base: "bottom" }, // bottom
        { cx: ax + mid,      cy: ay + pad,          align: "center", base: "top"    }, // top
        { cx: ax + pad,      cy: ay + mid,          align: "left",   base: "middle" }, // left
        { cx: ax + sz - pad, cy: ay + mid,          align: "right",  base: "middle" }, // right
    ];

    players.forEach((p, i) => {
        const { cx, cy, align, base } = layout[i];
        const scoreVal = gameMode === "2v2" ? teamScores[i <= 1 ? 0 : 1] : scores[i];
        const label = (window.myName && i === 0 ? window.myName : NAMES_HUD[i]) + "  ⚽ " + scoreVal;

        ctx.save();
        ctx.font = `700 ${fontSize}px 'Segoe UI', Arial`;
        ctx.textAlign = align;
        ctx.textBaseline = base;
        ctx.shadowColor = p.color;
        ctx.shadowBlur = 12;
        ctx.fillStyle = p.color;
        ctx.fillText(label, cx, cy);
        ctx.restore();
    });
}

function drawTimer() {
    const mins = Math.floor(gameTimeLeft / 60);
    const secs = Math.floor(gameTimeLeft % 60);
    const timeStr = `${mins}:${secs.toString().padStart(2, '0')}`;
    const urgent = gameTimeLeft <= 30;
    const size = Math.min(W, H) * 0.055;

    ctx.save();
    ctx.font = `900 ${size}px 'Segoe UI', Arial`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.shadowColor = urgent ? "#ff2d55" : "#00cfff";
    ctx.shadowBlur = urgent ? 28 : 14;
    ctx.fillStyle = urgent ? "#ff2d55" : "#ffffff";
    ctx.fillText(timeStr, W / 2, 8);
    ctx.restore();
}

function drawStreakMessage() {
    if (!streakMessage || streakMessage.timer <= 0) return;
    streakMessage.timer--;
    streakMessage.alpha = streakMessage.timer / 140;

    const size = Math.min(W, H) * 0.05;
    ctx.save();
    ctx.globalAlpha = streakMessage.alpha;
    ctx.font = `900 ${size}px 'Segoe UI'`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.shadowColor = "#ffd700";
    ctx.shadowBlur = 40;
    ctx.fillStyle = "#ffd700";
    ctx.fillText(streakMessage.text, W / 2, H / 2 + size * 2.2);
    ctx.restore();
}

// ===== ИНДИКАТОР СУПЕР УДАРА =====
function drawSuperIndicator() {
    players.forEach((p, pi) => {
        if (!p.alive) return;

        const ready = p.superTimer <= 0;
        const progress = ready ? 1 : 1 - (p.superTimer / SUPER_COOLDOWN);
        const pos = getPaddlePos(p);
        const cx = OFFSET_X + pos.x * ARENA;
        const cy = OFFSET_Y + pos.y * ARENA;
        const horiz = p.side === "top" || p.side === "bottom";
        const rW = PADDLE_R * ARENA * getPaddleScale(p);
        const rD = JOYSTICK_DEPTH;
        const bw = horiz ? rW : rD;
        const bh = horiz ? rD : rW;

        // Клип по форме полуэллипса
        ctx.save();
        ctx.beginPath();
        if (p.side === "bottom") ctx.ellipse(cx, cy, rW, rD, 0, Math.PI, 2*Math.PI);
        if (p.side === "top")    ctx.ellipse(cx, cy, rW, rD, 0, 0, Math.PI);
        if (p.side === "left")   ctx.ellipse(cx, cy, rD, rW, 0, 3*Math.PI/2, Math.PI/2);
        if (p.side === "right")  ctx.ellipse(cx, cy, rD, rW, 0, Math.PI/2, 3*Math.PI/2);
        ctx.closePath();
        ctx.clip();

        // Тёмный фон — всегда (при зарядке делает цвет в 2 раза темнее)
        ctx.fillStyle = "rgba(0,0,0,0.5)";
        ctx.fillRect(cx - bw, cy - bh, bw*2, bh*2);

        // Заливка в цвете игрока — пропорционально заряду
        if (progress > 0) {
            ctx.fillStyle = p.color;
            if (horiz) {
                ctx.fillRect(cx - bw, cy - bh, bw*2 * progress, bh*2);
            } else {
                ctx.fillRect(cx - bw, cy + bh - bh*2 * progress, bw*2, bh*2 * progress);
            }
        }
        ctx.restore();

        // Индикатор перезарядки выдвижения — серая дуга поверх клюшки
        if ((p.pushCooldown || 0) > 0) {
            const cdProgress = p.pushCooldown / 3; // 1 → 0
            ctx.save();
            ctx.beginPath();
            if (p.side === "bottom") ctx.ellipse(cx, cy, rW, rD, 0, Math.PI, 2*Math.PI);
            if (p.side === "top")    ctx.ellipse(cx, cy, rW, rD, 0, 0, Math.PI);
            if (p.side === "left")   ctx.ellipse(cx, cy, rD, rW, 0, 3*Math.PI/2, Math.PI/2);
            if (p.side === "right")  ctx.ellipse(cx, cy, rD, rW, 0, Math.PI/2, 3*Math.PI/2);
            ctx.closePath();
            ctx.clip();
            ctx.fillStyle = `rgba(0,0,0,${0.45 * cdProgress})`;
            ctx.fillRect(cx - bw, cy - bh, bw*2, bh*2);
            ctx.restore();
        }

    });
}

// ===== ИГРОВОЙ ЦИКЛ =====
let _lastFrameTime = 0;
function gameLoop(timestamp) {
    if (!gameRunning) return;
    const dt = _lastFrameTime ? Math.min((timestamp - _lastFrameTime) / (1000 / 60), 3) : 1;
    _lastFrameTime = timestamp;

    if (!multiMode || multiIsHost) {
        gameTimeLeft -= dt / 60;
    }
    if (gameTimeLeft <= 0) {
        gameTimeLeft = 0;
        draw();
        endGameByTimer();
        return;
    }

    savePrevPositions();
    handleInput(dt);
    updateBots(dt);
    updateBall(dt);

    // Страховка угла: если шар застрял в углу дольше 1.5 сек — выбить к центру
    if (!multiMode || multiIsHost) {
        const inCornerX = ball.x < CORNER_ZONE * 1.3 || ball.x > 1 - CORNER_ZONE * 1.3;
        const inCornerY = ball.y < CORNER_ZONE * 1.3 || ball.y > 1 - CORNER_ZONE * 1.3;
        if (inCornerX && inCornerY && !ballResetting) {
            ballCornerTimer += dt;
            if (ballCornerTimer >= 90) escapeCorner();
        } else {
            ballCornerTimer = 0;
        }
    }

    // Снитч
    if (!multiMode || multiIsHost) {
        if (!snitch) {
            snitchSpawnCountdown -= dt / 60;
            if (snitchSpawnCountdown <= 0) {
                snitch = {
                    x: 0.2 + Math.random() * 0.6,
                    y: 0.2 + Math.random() * 0.6,
                    vx: (Math.random() - 0.5) * 0.014,
                    vy: (Math.random() - 0.5) * 0.014,
                    r: SNITCH_R,
                    dirTimer: 0,
                    flutter: 0
                };
                snitchSpawnCountdown = 60;
            }
        }
        updateSnitch(dt);
        checkSnitchCollision();
    }

    draw();
    animId = requestAnimationFrame(gameLoop);
}

// ===== УПРАВЛЕНИЕ ЭКРАНАМИ =====
function showScreen(id) {
    document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
    document.getElementById(id).classList.add("active");
}

function startGame(mode) {
    if (mode) gameMode = mode;
    // Одиночная игра — сбрасываем на дефолт; мультиплеер — launchMultiGame выставит после
    if (mode === "1v3" && !multiMode) {
        localPlayerSide = "bottom";
        localPlayerIndex = 0;
    }
    stopMultiSync();
    resize();
    initGame();
    gameRunning = true;
    _lastFrameTime = 0;
    document.getElementById("hud").style.display = "none";
    showScreen("screen-game");
    requestAnimationFrame(gameLoop);
}

function goHome() {
    gameRunning = false;
    cancelAnimationFrame(animId);
    stopMultiSync();
    document.getElementById("hud").style.display = "";
    showScreen("screen-home");
}
