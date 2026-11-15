(function () {
    // 1. Проверяем, передал ли лоадер свой порт в ссылке (?loader_port=12345)
    const urlParams = new URLSearchParams(window.location.search);
    const portFromUrl = urlParams.get('loader_port');

    if (portFromUrl) {
        sessionStorage.setItem('snow_loader_port', portFromUrl);
        // Очищаем ссылку в браузере, чтобы выглядела красиво
        window.history.replaceState({}, document.title, window.location.pathname);
    }

    const activePort = sessionStorage.getItem('snow_loader_port');
    if (!activePort) return; // Если сайт открыли просто так (не из лоадера) — ничего не делаем

    // 2. Красивое уведомление в углу экрана (в стиле твоего сайта)
    function showToast(text, isSuccess = false) {
        let toast = document.getElementById('snow-loader-toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'snow-loader-toast';
            toast.style.cssText = `
                position: fixed; bottom: 20px; right: 20px; z-index: 99999;
                background: #0E1118; color: #F1F5F9; padding: 14px 18px;
                border-radius: 10px; border: 1px solid #3B82F6;
                font-family: sans-serif; font-size: 14px;
                box-shadow: 0 10px 25px rgba(0,0,0,0.6);
            `;
            document.body.appendChild(toast);
        }
        toast.style.borderColor = isSuccess ? '#22C55E' : '#3B82F6';
        toast.textContent = text;
    }

    showToast('Войдите в аккаунт, чтобы авторизоваться в SnowClient...');

    // 3. Функция отправки данных в C++ лоадер
    let alreadySent = false;
    window.sendAuthToLoader = async function (userData) {
        if (alreadySent || !userData) return;

        const payload = {
            username: String(userData.username || userData.login || userData.name || userData.email || 'User'),
            uid: String(userData.uid || userData.id || '1'),
            sub: String(userData.sub || userData.subscription || userData.role || 'Active'),
            token: String(userData.token || '')
        };

        try {
            const response = await fetch(`http://127.0.0.1:${activePort}/auth`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (response.ok) {
                alreadySent = true;
                sessionStorage.removeItem('snow_loader_port');
                showToast('Успешный вход! Можете вернуться в лоадер :)', true);
            }
        } catch (err) {
            console.error('Ошибка связи с лоадером:', err);
        }
    };

    // 4. Автоматический поиск вошедшего пользователя в хранилище браузера
    function checkLoggedInUser() {
        if (alreadySent) return;

        // Проверяем популярные ключи, куда сайты сохраняют профиль
        const possibleKeys = ['snow_user', 'user', 'currentUser', 'auth_user', 'account'];
        for (const key of possibleKeys) {
            const raw = localStorage.getItem(key) || sessionStorage.getItem(key);
            if (raw) {
                try {
                    const parsed = JSON.parse(raw);
                    if (parsed && (parsed.username || parsed.email || parsed.login || parsed.uid)) {
                        window.sendAuthToLoader(parsed);
                        return;
                    }
                } catch (e) {}
            }
        }

        // Если на сайте используется Firebase Auth
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith('firebase:authUser:')) {
                try {
                    const fbUser = JSON.parse(localStorage.getItem(k));
                    if (fbUser && fbUser.email) {
                        window.sendAuthToLoader({
                            username: fbUser.displayName || fbUser.email.split('@')[0],
                            uid: fbUser.uid,
                            sub: 'Active',
                            token: fbUser.stsTokenManager ? fbUser.stsTokenManager.accessToken : ''
                        });
                        return;
                    }
                } catch (e) {}
            }
        }
    }

    // Проверяем сразу при загрузке и затем каждую секунду (на случай если юзер только вводит пароль)
    checkLoggedInUser();
    setInterval(checkLoggedInUser, 1000);
})();