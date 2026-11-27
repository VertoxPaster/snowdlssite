(function () {
    const validPort = p => (/^\d{4,5}$/.test(String(p || '')) && +p >= 1024 && +p <= 65535) ? String(+p) : null;
    const validState = s => /^[0-9a-fA-F]{16,64}$/.test(String(s || '')) ? String(s) : null;

    const urlParams = new URLSearchParams(window.location.search);
    const portFromUrl = validPort(urlParams.get('loader_port'));
    const stateFromUrl = validState(urlParams.get('state'));

    if (portFromUrl && stateFromUrl) {
        sessionStorage.setItem('snow_client_port', portFromUrl);
        sessionStorage.setItem('snow_client_state', stateFromUrl);
        window.history.replaceState({}, document.title, window.location.pathname);
    }

    const activePort = validPort(sessionStorage.getItem('snow_client_port'));
    const activeState = validState(sessionStorage.getItem('snow_client_state'));
    if (!activePort || !activeState) {
        sessionStorage.removeItem('snow_client_port');
        sessionStorage.removeItem('snow_client_state');
        return;
    }

    function showToast(text, isSuccess = false) {
        let toast = document.getElementById('snow-client-toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'snow-client-toast';
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

    showToast('Войдите в аккаунт на сайте, чтобы войти в SnowClient...');

    let alreadySent = false;
    window.sendAuthToClient = async function (userData) {
        if (alreadySent || !userData || !userData.username) return;

        const payload = {
            username: String(userData.username),
            uid: String(userData.uid || '1'),
            sub: String(userData.sub || 'Active'),
            token: String(userData.token || ''),
            state: activeState
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
                sessionStorage.removeItem('snow_client_port');
                sessionStorage.removeItem('snow_client_state');
                showToast('Успешный вход! Вернитесь в SnowClient :)', true);
            } else {
                showToast('Клиент отклонил вход (код ' + response.status + ')');
            }
        } catch (err) {
            console.error('[SnowClient] Ошибка отправки в клиент:', err);
            showToast('Не удалось связаться с клиентом. Он запущен?');
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
                const tr = await fetch('/api/auth/loader-token', {
                    method: 'POST',
                    headers: { 'Authorization': 'Bearer ' + token }
                });
                if (!tr.ok) return;
                const lt = (await tr.json()).token;
                if (!lt) return;
                await window.sendAuthToClient({
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

    checkLoggedInUser();
    window.addEventListener('storage', e => { if (e.key === 'vortex_token') checkLoggedInUser(); });
    const startedAt = Date.now();
    const timer = setInterval(() => {
        if (alreadySent || Date.now() - startedAt > 10 * 60 * 1000) return clearInterval(timer);
        checkLoggedInUser();
    }, 3000);
})();