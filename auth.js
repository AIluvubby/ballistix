// ===== АВТОРИЗАЦИЯ =====

function initAuth() {
    if (!initFirebase()) return;
    firebase.auth().onAuthStateChanged(user => {
        if (user && user.emailVerified) {
            window.myName = user.displayName || user.email.split('@')[0];
            myUid = user.uid;
            sessionStorage.setItem('ballistix_uid', user.uid);
            const nameEl = document.getElementById('home-player-name');
            if (nameEl) nameEl.textContent = window.myName;
            showScreen('screen-home');
            if (typeof loadUserProfile === 'function') loadUserProfile();
        } else {
            showScreen('screen-auth');
        }
    });
}

function authTab(tab) {
    document.getElementById('form-login').style.display    = tab === 'login'    ? '' : 'none';
    document.getElementById('form-register').style.display = tab === 'register' ? '' : 'none';
    document.getElementById('tab-login').classList.toggle('active', tab === 'login');
    document.getElementById('tab-register').classList.toggle('active', tab === 'register');
    setAuthMsg('', '');
}

function setAuthMsg(err, ok) {
    document.getElementById('auth-error').textContent   = err;
    document.getElementById('auth-success').textContent = ok;
}

async function authRegister() {
    const name  = document.getElementById('auth-reg-name').value.trim();
    const email = document.getElementById('auth-reg-email').value.trim();
    const pass  = document.getElementById('auth-reg-pass').value;

    if (!name)          { setAuthMsg('Введите имя', '');                        return; }
    if (!email)         { setAuthMsg('Введите email', '');                      return; }
    if (pass.length < 6){ setAuthMsg('Пароль минимум 6 символов', '');          return; }

    setAuthMsg('', '');
    try {
        const cred = await firebase.auth().createUserWithEmailAndPassword(email, pass);
        await cred.user.updateProfile({ displayName: name });
        await cred.user.sendEmailVerification();
        await firebase.auth().signOut();
        setAuthMsg('', '✉ Письмо отправлено! Подтвердите email и войдите.');
        authTab('login');
    } catch (e) {
        setAuthMsg(authErrText(e.code), '');
    }
}

async function authLogin() {
    const email = document.getElementById('auth-login-email').value.trim();
    const pass  = document.getElementById('auth-login-pass').value;

    if (!email || !pass) { setAuthMsg('Введите email и пароль', ''); return; }
    setAuthMsg('', '');
    try {
        const cred = await firebase.auth().signInWithEmailAndPassword(email, pass);
        if (!cred.user.emailVerified) {
            await firebase.auth().signOut();
            setAuthMsg('Email не подтверждён — проверьте почту', '');
            return;
        }
        // onAuthStateChanged переключит на home
    } catch (e) {
        setAuthMsg(authErrText(e.code), '');
    }
}

async function authResend() {
    const email = document.getElementById('auth-login-email').value.trim();
    const pass  = document.getElementById('auth-login-pass').value;
    if (!email || !pass) { setAuthMsg('Введите email и пароль чтобы выслать письмо повторно', ''); return; }
    try {
        const cred = await firebase.auth().signInWithEmailAndPassword(email, pass);
        await cred.user.sendEmailVerification();
        await firebase.auth().signOut();
        setAuthMsg('', '✉ Письмо выслано повторно!');
    } catch (e) {
        setAuthMsg(authErrText(e.code), '');
    }
}

function authLogout() {
    firebase.auth().signOut();
}

function authErrText(code) {
    const map = {
        'auth/email-already-in-use': 'Этот email уже зарегистрирован',
        'auth/invalid-email':        'Неверный формат email',
        'auth/weak-password':        'Пароль слишком простой',
        'auth/user-not-found':       'Пользователь не найден',
        'auth/wrong-password':       'Неверный пароль',
        'auth/invalid-credential':   'Неверный email или пароль',
        'auth/too-many-requests':    'Слишком много попыток — попробуйте позже',
        'auth/network-request-failed': 'Ошибка сети',
    };
    return map[code] || ('Ошибка: ' + code);
}

// Запуск после загрузки страницы
window.addEventListener('load', initAuth);
