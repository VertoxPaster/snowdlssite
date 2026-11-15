/* ============================================================
   SNOWCLIENT — CABINET SCRIPT
   ============================================================ */

'use strict';

let currentLang = localStorage.getItem('snow_lang') || CONFIG.defaultLanguage || 'ru';
const TOKEN_KEY = CONFIG.auth?.tokenKey || 'vortex_token';
const CUR = CONFIG.auth?.balanceCurrency || '₽';
const FUNPAY_URL = CONFIG.payment?.funpayUrl || 'https://funpay.com/lots/offer?id=78533148';

let currentUser = null;
let userBalance = 0;

const tt = key => (CONFIG.i18n[currentLang] && CONFIG.i18n[currentLang][key]) ?? CONFIG.i18n.ru[key] ?? key;
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtMoney = n => (Number(n) || 0).toFixed(2) + ' ' + CUR;

function getToken() { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } }
function setToken(t) { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch {} }

function handleExpired() {
  setToken(null);
  location.replace('/?auth=login&next=cabinet');
}

async function api(path, { method = 'GET', body, token = getToken(), timeout = 8000 } = {}) {
  const headers = { 'Accept': 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = 'Bearer ' + token;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);

  try {
    const res = await fetch(path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal
    });

    let data = {};
    try { data = await res.json(); } catch {}
    if (!res.ok) {
      const err = new Error(data.message || ('HTTP ' + res.status));
      err.status = res.status;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  applyColors();
  bindPaymentLinks();
  buildLangDropdown();
  setLanguage(currentLang);
  setupSnow();
  setupSpotlight();

  document.addEventListener('click', e => {
    const sel = document.getElementById('langSelector');
    if (sel && !sel.contains(e.target)) closeLangDropdown();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeLangDropdown();
  });

  const hashTab = location.hash.replace('#', '');
  if (['overview', 'loader', 'keys', 'settings'].includes(hashTab)) {
    switchCabTab(hashTab);
  }

  await bootCabinet();
});

function bindPaymentLinks() {
  ['cabBuyTopBtn', 'cabBuyLoaderBtn', 'cabBuyKeysBtn'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.href = FUNPAY_URL;
  });
}

function applyColors() {
  const c = CONFIG.colors;
  const s = document.documentElement.style;
  s.setProperty('--primary', c.primary);
  s.setProperty('--primary-light', c.primaryLight);
  s.setProperty('--primary-dark', c.primaryDark);
  s.setProperty('--secondary', c.secondary);
  if (c.accent) s.setProperty('--accent', c.accent);
  s.setProperty('--bg', c.bg);
  s.setProperty('--bg-card', c.bgCard);
  s.setProperty('--bg-card-hover', c.bgCardHover);
  s.setProperty('--text', c.text);
  s.setProperty('--text-muted', c.textMuted);
  s.setProperty('--border', c.border);
  s.setProperty('--success', c.success);
  s.setProperty('--glow', c.glow);
}

async function bootCabinet() {
  const token = getToken();
  if (!token) {
    handleExpired();
    return;
  }

  try {
    const me = await api('/api/auth/me');
    currentUser = me.data || me.user;
    if (!currentUser) throw new Error('Unauthorized');

    userBalance = Number(currentUser.balance ?? 0);
    renderProfile();
    await loadPurchases();
  } catch (e) {
    handleExpired();
  }
}

function renderProfile() {
  const u = currentUser;
  if (!u) return;

  const uname = u.username || '?';
  const displayName = (u.display_name || '').trim() || uname;

  const av = document.getElementById('cabAvatar');
  if (av) {
    if (u.avatar) {
      av.innerHTML = `<img src="${esc(u.avatar)}" alt="" onerror="this.parentNode.textContent='${esc(uname.charAt(0))}'">`;
    } else {
      av.textContent = uname.charAt(0);
    }
  }

  document.getElementById('cabName').textContent = displayName;

  const metaParts = [];
  if (displayName.toLowerCase() !== uname.toLowerCase()) metaParts.push('@' + uname);
  if (u.email) metaParts.push(u.email);
  document.getElementById('cabEmail').textContent = metaParts.join(' · ');

  document.getElementById('setDisplayName').value = displayName;

  const roleEl = document.getElementById('cabRole');
  const roleMap = {
    admin: tt('roleAdmin'),
    moderator: tt('roleModerator'),
    beta_tester: tt('roleBeta')
  };
  roleEl.textContent = roleMap[u.role] || tt('roleUser');
  roleEl.classList.toggle('admin', u.role === 'admin');

  const hasSub = Boolean(u.has_subscription);
  const subPill = document.getElementById('cabSubPill');
  subPill.textContent = hasSub ? tt('cabSubActive') : tt('cabSubInactive');
  subPill.className = 'cab-sub-pill ' + (hasSub ? 'active' : 'inactive');

  document.getElementById('cabBalance').textContent = fmtMoney(userBalance);
  document.getElementById('cabRef').textContent = u.ref_code || '—';

  const adminBtn = document.getElementById('cabAdminBtn');
  if (adminBtn) {
    adminBtn.hidden = u.role !== 'admin';
    adminBtn.href = CONFIG.auth?.adminUrl || '/admin';
  }

  // Статус HWID
  const hwid = (u.hwid || '').trim();
  const hwidState = document.getElementById('cabHwidState');
  const hwidDate = document.getElementById('cabHwidDate');
  const bindNote = document.getElementById('loaderBindNote');

  if (hwid) {
    const masked = hwid.length > 10 ? `${hwid.slice(0, 6)}...${hwid.slice(-4)}` : hwid;
    hwidState.textContent = `${tt('cabHwidBound')} (${masked})`;
    hwidState.classList.add('is-bound');
    hwidState.classList.remove('is-unbound');
    hwidDate.textContent = u.hwid_bound_at ? fmtDate(u.hwid_bound_at) : tt('cabHwidBound');
    if (bindNote) bindNote.textContent = `${tt('cabHwidBound')}: ${masked}`;
  } else {
    hwidState.textContent = tt('cabHwidUnbound');
    hwidState.classList.add('is-unbound');
    hwidState.classList.remove('is-bound');
    hwidDate.textContent = tt('cabHwidHint');
    if (bindNote) bindNote.textContent = tt('cabHwidHint');
  }

  // Блок скачивания лоадера
  document.getElementById('loaderAllowedBox').hidden = !hasSub;
  document.getElementById('loaderLockedBox').hidden = hasSub;
}

function switchCabTab(tab) {
  document.querySelectorAll('.cab-nav-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  document.querySelectorAll('.cab-panel').forEach(p => {
    p.classList.toggle('active', p.id === 'panel-' + tab);
  });
  history.replaceState(null, '', '#' + tab);
}

function fmtDate(iso) {
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleDateString(currentLang === 'uk' ? 'uk-UA' : currentLang === 'en' ? 'en-GB' : currentLang, {
    day: '2-digit', month: 'short', year: 'numeric'
  });
}

async function loadPurchases() {
  const ul = document.getElementById('cabPurchases');
  if (!ul) return;
  try {
    const r = await api('/api/users/products');
    const list = r.data || [];
    if (!list.length) {
      ul.innerHTML = `<li class="cab-empty">${esc(tt('cabNoPurchases'))}</li>`;
      return;
    }
    const now = Date.now();
    ul.innerHTML = list.map((p, i) => {
      const expMs = p.expires_at ? Date.parse(p.expires_at) : NaN;
      const isExpired = !isNaN(expMs) && expMs < now;
      const badgeText = p.expires_at
        ? (isExpired ? `${tt('cabExpired')} (${fmtDate(p.expires_at)})` : `${tt('cabUntil')}${fmtDate(p.expires_at)}`)
        : tt('cabForever');

      return `
        <li class="cab-purchase" style="--st:${Math.min(i, 8) * 50}ms">
          <div class="cab-purchase-info">
            <div class="cab-purchase-title">${esc(p.title || ('#' + p.product_id))}</div>
            <div class="cab-purchase-meta">${esc(fmtDate(p.purchased_at))}</div>
          </div>
          <span class="cab-purchase-badge ${isExpired ? 'expired' : ''}">${esc(badgeText)}</span>
        </li>`;
    }).join('');
  } catch (e) {
    if (e.status === 401) return handleExpired();
    ul.innerHTML = `<li class="cab-empty">${esc(e.message)}</li>`;
  }
}

async function downloadLoader() {
  const btn = document.getElementById('btnDownloadLoader');
  if (!btn || btn.classList.contains('loading')) return;
  btn.classList.add('loading');

  try {
    const res = await api('/api/loader/download');
    if (res.url) {
      window.open(res.url, '_blank', 'noopener');
      showToast(tt('loaderStarted'), 'success');
      return;
    }

    const binRes = await fetch('/api/loader/download', {
      headers: {
        'Authorization': 'Bearer ' + getToken(),
        'Accept': 'application/octet-stream'
      }
    });
    if (binRes.status === 401) {
      handleExpired();
      return;
    }
    if (!binRes.ok) {
      let msg = 'Ошибка загрузки';
      try { msg = (await binRes.json()).message || msg; } catch {}
      throw new Error(msg);
    }

    const blob = await binRes.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = res.filename || 'SnowClient.exe';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    showToast(tt('loaderStarted'), 'success');
  } catch (err) {
    if (err.status === 401) return handleExpired();
    showToast(err.message, 'error');
  } finally {
    btn.classList.remove('loading');
  }
}

async function activateKey(e) {
  e.preventDefault();
  const input = document.getElementById('cabKeyInput');
  const btn = document.getElementById('cabKeyBtn');
  const key = input.value.trim();
  if (!key) return showToast(tt('cabKeyEmpty'), 'error');
  if (btn.classList.contains('loading')) return;

  btn.classList.add('loading');
  try {
    const r = await api('/api/keys/activate', { method: 'POST', body: { key } });
    const title = r.product?.title || r.data?.product?.title || '';
    input.value = '';
    showToast(tt('cabKeyOk') + title, 'success');

    const me = await api('/api/auth/me');
    currentUser = me.data || me.user || currentUser;
    userBalance = Number(currentUser.balance ?? userBalance);
    renderProfile();
    await loadPurchases();
  } catch (err) {
    if (err.status === 401) return handleExpired();
    showToast(err.message, 'error');
  } finally {
    btn.classList.remove('loading');
  }
}

async function saveDisplayName(e) {
  e.preventDefault();
  const input = document.getElementById('setDisplayName');
  const btn = document.getElementById('saveNameBtn');
  const val = input.value.trim();
  if (!val || (btn && btn.classList.contains('loading'))) return;

  if (btn) btn.classList.add('loading');
  try {
    const r = await api('/api/profile/me', { method: 'PATCH', body: { display_name: val } });
    currentUser = r.data || r.user || currentUser;
    renderProfile();
    showToast(tt('cabSaved'), 'success');
  } catch (err) {
    if (err.status === 401) return handleExpired();
    showToast(err.message, 'error');
  } finally {
    if (btn) btn.classList.remove('loading');
  }
}

async function changePassword(e) {
  e.preventDefault();
  const btn = document.getElementById('changePassBtn');
  const curInput = document.getElementById('setCurPass');
  const newInput = document.getElementById('setNewPass');
  const cur = curInput.value;
  const nw = newInput.value;

  if (!cur || !nw || (btn && btn.classList.contains('loading'))) return;
  if (nw.length < 6) {
    showToast(tt('authShort'), 'error');
    return;
  }

  if (btn) btn.classList.add('loading');
  try {
    await api('/api/auth/password', { method: 'PUT', body: { currentPassword: cur, newPassword: nw } });
    curInput.value = '';
    newInput.value = '';
    showToast(tt('cabPassChanged'), 'success');
  } catch (err) {
    if (err.status === 401) return handleExpired();
    showToast(err.message, 'error');
  } finally {
    if (btn) btn.classList.remove('loading');
  }
}

function copyRefCode() {
  const code = currentUser?.ref_code;
  if (!code) return;

  const done = () => showToast(tt('cabCopied'), 'success');
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(code).then(done).catch(() => fallbackCopy(code, done));
  } else {
    fallbackCopy(code, done);
  }
}

function fallbackCopy(text, onSuccess) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    if (document.execCommand('copy')) onSuccess();
    ta.remove();
  } catch {}
}

async function logout() {
  try { await api('/api/auth/logout', { method: 'POST', body: {} }); } catch {}
  setToken(null);
  location.replace('/');
}

/* ── Языки ── */
function buildLangDropdown() {
  const dropdown = document.getElementById('langDropdown');
  if (!dropdown) return;
  dropdown.innerHTML = CONFIG.languages.map(l => `
    <div class="lang-option ${l.code === currentLang ? 'active' : ''}" onclick="setLanguage('${l.code}')">
      <span class="lang-flag">${l.flag}</span>
      <span>${l.full}</span>
      <span class="lang-code-badge">${l.label}</span>
    </div>
  `).join('');
}

function toggleLangDropdown() {
  document.getElementById('langBtn')?.classList.toggle('open');
  document.getElementById('langDropdown')?.classList.toggle('open');
}

function closeLangDropdown() {
  document.getElementById('langBtn')?.classList.remove('open');
  document.getElementById('langDropdown')?.classList.remove('open');
}

function setLanguage(lang) {
  currentLang = lang;
  try { localStorage.setItem('snow_lang', lang); } catch {}
  const found = CONFIG.languages.find(l => l.code === lang);
  document.getElementById('langLabel').textContent = found?.label ?? lang.toUpperCase();
  document.getElementById('langFlag').textContent = found?.flag ?? '';

  document.querySelectorAll('.lang-option').forEach((el, i) => {
    el.classList.toggle('active', CONFIG.languages[i]?.code === lang);
  });

  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    const val = tt(key);
    if (val && val !== key) el.textContent = val;
  });

  const keyInput = document.getElementById('cabKeyInput');
  if (keyInput) keyInput.placeholder = tt('cabKeyPh');

  document.documentElement.lang = lang;
  closeLangDropdown();
  if (currentUser) {
    renderProfile();
    loadPurchases();
  }
}

/* ── Снег и Spotlight ── */
function setupSnow() {
  const canvas = document.getElementById('snowCanvas');
  if (!canvas || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const ctx = canvas.getContext('2d');
  let w = 0, h = 0, flakes = [];

  function resize() {
    w = canvas.width = window.innerWidth;
    h = canvas.height = window.innerHeight;
    flakes = Array.from({ length: Math.min(70, Math.floor((w * h) / 22000)) }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      r: 0.7 + Math.random() * 1.6,
      vy: 0.25 + Math.random() * 0.65,
      sway: Math.random() * Math.PI * 2,
      a: 0.2 + Math.random() * 0.4
    }));
  }

  function frame() {
    ctx.clearRect(0, 0, w, h);
    for (const f of flakes) {
      f.sway += 0.008;
      f.y += f.vy;
      f.x += Math.sin(f.sway) * 0.28;
      if (f.y > h) { f.y = -5; f.x = Math.random() * w; }
      ctx.beginPath();
      ctx.fillStyle = `rgba(203, 224, 255, ${f.a})`;
      ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
      ctx.fill();
    }
    requestAnimationFrame(frame);
  }
  window.addEventListener('resize', resize);
  resize();
  requestAnimationFrame(frame);
}

function setupSpotlight() {
  document.addEventListener('mousemove', e => {
    const card = e.target.closest?.('.spot');
    if (!card) return;
    const r = card.getBoundingClientRect();
    card.style.setProperty('--mx', (e.clientX - r.left) + 'px');
    card.style.setProperty('--my', (e.clientY - r.top) + 'px');
  }, { passive: true });
}

let toastTimer = null;
function showToast(msg, type = 'success') {
  const toast = document.getElementById('toast');
  const toastMsg = document.getElementById('toastMsg');
  if (!toast || !toastMsg) return;
  toastMsg.textContent = msg;
  toast.className = `toast ${type} show`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3500);
}