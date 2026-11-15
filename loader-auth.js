(function () {
    // Порт принимаем ТОЛЬКО как число 1024–65535. Иначе строка вроде "1@evil.com" превращала
    // адрес в http://127.0.0.1:1@evil.com/auth и токен уходил на чужой сервер.
    const validPort = p => (/^\d{4,5}$/.test(String(p || '')) && +p >= 1024 && +p <= 65535) ? String(+p) : null;
    const urlParams = new URLSearchParams(window.location.search);
    const portFromUrl = validPort(urlParams.get('loader_port'));

    if (portFromUrl) {
        sessionStorage.setItem('snow_loader_port', portFromUrl);
        window.history.replaceState({}, document.title, window.location.pathname);
    }

    const activePort = validPort(sessionStorage.getItem('snow_loader_port'));
    if (!activePort) { sessionStorage.removeItem('snow_loader_port'); return; }

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
                credentials: 'omit',
                referrerPolicy: 'no-referrer',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (response.ok) {
                alreadySent = true;
                sessionStorage.removeItem('snow_loader_port');
                showToast('Успешный вход! Вернитесь в SnowClient :)', true);
            } else {
                showToast('Лоадер отклонил вход (код ' + response.status + ')');
            }
        } catch (err) {
            console.error('[SnowLoader] Ошибка отправки в лоадер:', err);
            showToast('Не удалось связаться с лоадером. Он запущен?');
        }
    };

    let checking = false;
    async function checkLoggedInUser() {
        if (alreadySent || checking) return;
        let token = null;
        try { token = localStorage.getItem('vortex_token'); } catch (e) {}
        if (!token) return;

        checking = true;
        try {
            const r = await fetch('/api/auth/me', {
                headers: { 'Authorization': 'Bearer ' + token }
            });
            if (!r.ok) return;
            const j = await r.json();
            const u = j.data || j.user;
            if (u && u.username) {
                // В лоадер уходит отдельный короткоживущий токен (12 ч, ограниченные права),
                // а не основной токен сессии сайта.
                const tr = await fetch('/api/auth/loader-token', {
                    method: 'POST',
                    headers: { 'Authorization': 'Bearer ' + token }
                });
                if (!tr.ok) return;
                const lt = (await tr.json()).token;
                if (!lt) return;
                await window.sendAuthToLoader({
                    username: u.username,
                    uid: u.id,
                    sub: u.has_subscription ? 'Active' : 'None',
                    token: lt
                });
            }
        } catch (e) {
        } finally {
            checking = false;
        }
    }

    // Не долбим сервер каждую секунду: реагируем на вход в другой вкладке и редко опрашиваем,
    // максимум 10 минут, потом останавливаемся.
    checkLoggedInUser();
    window.addEventListener('storage', e => { if (e.key === 'vortex_token') checkLoggedInUser(); });
    const startedAt = Date.now();
    const timer = setInterval(() => {
        if (alreadySent || Date.now() - startedAt > 10 * 60 * 1000) return clearInterval(timer);
        checkLoggedInUser();
    }, 3000);
})();