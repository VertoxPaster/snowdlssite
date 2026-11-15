(function () {
    const urlParams = new URLSearchParams(window.location.search);
    const portFromUrl = urlParams.get('loader_port');

    if (portFromUrl) {
        sessionStorage.setItem('snow_loader_port', portFromUrl);
        window.history.replaceState({}, document.title, window.location.pathname);
    }

    const activePort = sessionStorage.getItem('snow_loader_port');
    if (!activePort) return;

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

    showToast('Войдите в аккаунт на сайте для входа в лоадер...');

    let alreadySent = false;
    window.sendAuthToLoader = async function (userData) {
        if (alreadySent || !userData || !userData.username) return;

        const payload = {
            username: String(userData.username),
            uid: String(userData.uid || '1'),
            sub: String(userData.sub || 'Active'),
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
                showToast('Успешный вход! Вернитесь в SnowClient :)', true);
            }
        } catch (err) {
            console.error('[SnowLoader] Ошибка отправки в лоадер:', err);
        }
    };

    function checkLoggedInUser() {
        if (alreadySent) return;

        // 1. Проверяем JSON-объекты во всех ключах localStorage и sessionStorage
        for (const storage of [localStorage, sessionStorage]) {
            for (let i = 0; i < storage.length; i++) {
                const k = storage.key(i);
                const raw = storage.getItem(k);
                if (!raw) continue;

                // Firebase Auth
                if (k.startsWith('firebase:authUser:')) {
                    try {
                        const fb = JSON.parse(raw);
                        if (fb && fb.email) {
                            window.sendAuthToLoader({
                                username: fb.displayName || fb.email.split('@')[0],
                                uid: fb.uid,
                                token: fb.stsTokenManager ? fb.stsTokenManager.accessToken : ''
                            });
                            return;
                        }
                    } catch (e) {}
                }

                // Любой JSON с профилем
                if (raw.startsWith('{')) {
                    try {
                        const obj = JSON.parse(raw);
                        const name = obj.username || obj.login || obj.name || obj.nick || obj.email;
                        if (name) {
                            window.sendAuthToLoader({
                                username: name,
                                uid: obj.uid || obj.id || '1',
                                sub: obj.sub || obj.subscription || obj.group || 'Active',
                                token: obj.token || obj.accessToken || ''
                            });
                            return;
                        }
                    } catch (e) {}
                }
            }
        }

        // 2. Проверяем, если логин и токен лежат отдельными строками
        const directName = localStorage.getItem('username') || localStorage.getItem('login') ||
                           sessionStorage.getItem('username') || sessionStorage.getItem('login');
        if (directName) {
            window.sendAuthToLoader({
                username: directName,
                uid: localStorage.getItem('uid') || '1',
                token: localStorage.getItem('token') || ''
            });
            return;
        }
    }

    checkLoggedInUser();
    setInterval(checkLoggedInUser, 1000);
})();