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
  setupSpotlight();

  document.getElementById('avatarFile')?.addEventListener('change', e => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (f) uploadAvatar(f);
  });

  document.addEventListener('click', e => {
    const sel = document.getElementById('langSelector');
    if (sel && !sel.contains(e.target)) closeLangDropdown();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeLangDropdown();
  });

  setupCabNav();

  await bootCabinet();
});

function bindPaymentLinks() {
  ['cabBuyTopBtn', 'cabBuyClientBtn', 'cabBuyKeysBtn'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.removeAttribute('target');
    el.href = '#buy';
    el.addEventListener('click', e => {
      e.preventDefault();
      openPaymentModal('month');
    });
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
  const displayName = uname; // отображаемое имя = ник, менять нельзя

  renderAvatar(document.getElementById('cabAvatar'), u);
  renderAvatar(document.getElementById('setAvatarPreview'), u);
  const rm = document.getElementById('avatarRemoveBtn');
  if (rm) rm.hidden = !u.avatar;

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

  const adminBtn = document.getElementById('cabAdminBtn');
  if (adminBtn) {
    adminBtn.hidden = u.role !== 'admin';
    adminBtn.href = CONFIG.auth?.adminUrl || '/admin';
  }

  // Статус HWID
  const hwid = (u.hwid || '').trim();
  const hwidState = document.getElementById('cabHwidState');
  const hwidDate = document.getElementById('cabHwidDate');
  const bindNote = document.getElementById('clientBindNote');

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

  // Запуски клиента
  const launches = Number(u.launch_count) || 0;
  const lcEl = document.getElementById('cabLaunchCount');
  const llEl = document.getElementById('cabLaunchLast');
  if (lcEl) lcEl.textContent = launches.toLocaleString(currentLang === 'uk' ? 'uk-UA' : currentLang);
  if (llEl) llEl.textContent = u.last_launch_at ? tt('cabLaunchLast') + fmtDate(u.last_launch_at) : tt('cabLaunchNone');

  updateNavBadges(hasSub);

  // Блок скачивания клиента
  document.getElementById('clientAllowedBox').hidden = !hasSub;
  document.getElementById('clientLockedBox').hidden = hasSub;
}

/* аватар по умолчанию: static/ava.png, если свой не загружен (или не открылся) */
const DEFAULT_AVATAR = '/static/ava.png';
function renderAvatar(el, u) {
  if (!el || !u) return;
  const uname = u.username || '?';
  const custom = u.avatar && /^\/uploads\/local\/[\w.-]+$/.test(String(u.avatar));
  const img = document.createElement('img');
  img.alt = '';
  let fell = false;
  img.addEventListener('error', () => {
    if (custom && !fell) { fell = true; img.src = DEFAULT_AVATAR; }
    else { img.remove(); el.textContent = uname.charAt(0); }
  });
  img.src = custom ? u.avatar : DEFAULT_AVATAR;
  el.textContent = '';
  el.append(img);
}

/* ── Навигация кабинета ── */
const CAB_TABS = ['overview', 'client', 'keys', 'settings'];
const CAB_TAB_KEYS = { overview: 'cabTabOverview', client: 'cabTabClient', keys: 'cabTabKeys', settings: 'cabTabSettings' };
let cabTab = 'overview';

function readTabFromUrl() {
  const h = location.hash.replace('#', '');
  if (CAB_TABS.includes(h)) return h;
  try {
    const saved = sessionStorage.getItem('cab_tab');
    if (CAB_TABS.includes(saved)) return saved;
  } catch {}
  return 'overview';
}

function updateCrumb() {
  const cur = document.getElementById('cabCrumbCurrent');
  if (cur) cur.textContent = tt(CAB_TAB_KEYS[cabTab]);
  document.title = tt(CAB_TAB_KEYS[cabTab]) + ' — ' + tt('cabTitle') + ' — SnowClient';
}

function switchCabTab(tab, opts = {}) {
  if (!CAB_TABS.includes(tab)) tab = 'overview';
  const { push = true, focus = false, scroll = true } = opts;
  cabTab = tab;

  document.querySelectorAll('[data-tab]').forEach(b => {
    const on = b.dataset.tab === tab;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
    b.tabIndex = on ? 0 : -1;
    if (on && focus && b.offsetParent !== null) b.focus({ preventScroll: true });
  });
  document.querySelectorAll('.cab-panel').forEach(p => {
    p.classList.toggle('active', p.id === 'panel-' + tab);
  });

  updateCrumb();
  try { sessionStorage.setItem('cab_tab', tab); } catch {}

  if (push && location.hash !== '#' + tab) {
    history.pushState(null, '', '#' + tab);
  }

  if (scroll) {
    const layout = document.querySelector('.cab-layout');
    if (layout && layout.getBoundingClientRect().top < 70) {
      layout.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }
}

function setupCabNav() {
  switchCabTab(readTabFromUrl(), { push: false, scroll: false });
  if (location.hash.replace('#', '') !== cabTab) {
    history.replaceState(null, '', '#' + cabTab);
  }

  // Назад / вперёд в браузере и ручная правка хэша
  window.addEventListener('hashchange', () => {
    const h = location.hash.replace('#', '');
    if (CAB_TABS.includes(h) && h !== cabTab) switchCabTab(h, { push: false });
  });

  // Стрелки внутри списка вкладок (боковое меню и нижняя панель)
  document.querySelectorAll('[role="tablist"]').forEach(list => {
    list.addEventListener('keydown', e => {
      const keys = ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'];
      if (!keys.includes(e.key)) return;
      e.preventDefault();
      let i = CAB_TABS.indexOf(cabTab);
      if (e.key === 'Home') i = 0;
      else if (e.key === 'End') i = CAB_TABS.length - 1;
      else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') i = (i + 1) % CAB_TABS.length;
      else i = (i - 1 + CAB_TABS.length) % CAB_TABS.length;
      switchCabTab(CAB_TABS[i], { focus: true, scroll: false });
    });
  });

  // Горячие клавиши 1–4
  document.addEventListener('keydown', e => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
    const n = parseInt(e.key, 10);
    if (n >= 1 && n <= CAB_TABS.length) switchCabTab(CAB_TABS[n - 1]);
  });
}

function updateNavBadges(hasSub) {
  document.querySelectorAll('[data-badge="client"]').forEach(el => { el.hidden = hasSub; });
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

async function downloadClient() {
  const btn = document.getElementById('btnDownloadClient');
  if (!btn || btn.classList.contains('loading')) return;
  btn.classList.add('loading');

  try {
    const res = await api('/api/loader/download');
    if (res.url) {
      window.open(res.url, '_blank', 'noopener');
      showToast(tt('clientStarted'), 'success');
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
    showToast(tt('clientStarted'), 'success');
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

const AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const AVATAR_MAX = 2 * 1024 * 1024;

function pickAvatar() {
  document.getElementById('avatarFile')?.click();
}

function setAvatarBusy(on) {
  document.getElementById('avatarUploadBtn')?.classList.toggle('loading', on);
  document.getElementById('cabAvatarBtn')?.classList.toggle('busy', on);
}

async function uploadAvatar(file) {
  if (!AVATAR_TYPES.includes(file.type) || file.size > AVATAR_MAX) {
    return showToast(tt('cabAvatarBad'), 'error');
  }
  setAvatarBusy(true);
  try {
    const fd = new FormData();
    fd.append('avatar', file);
    const res = await fetch('/api/profile/me/avatar', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + getToken() },
      body: fd
    });
    let data = {};
    try { data = await res.json(); } catch {}
    if (!res.ok) {
      const err = new Error(data.message || ('HTTP ' + res.status));
      err.status = res.status;
      throw err;
    }
    currentUser = data.user || (data.data && data.data.user) || currentUser;
    renderProfile();
    showToast(tt('cabAvatarSaved'), 'success');
  } catch (err) {
    if (err.status === 401) return handleExpired();
    showToast(err.message, 'error');
  } finally {
    setAvatarBusy(false);
  }
}

async function removeAvatar() {
  setAvatarBusy(true);
  try {
    const r = await api('/api/profile/me/avatar', { method: 'DELETE' });
    currentUser = r.user || (r.data && r.data.user) || currentUser;
    renderProfile();
    showToast(tt('cabAvatarRemoved'), 'success');
  } catch (err) {
    if (err.status === 401) return handleExpired();
    showToast(err.message, 'error');
  } finally {
    setAvatarBusy(false);
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

  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    el.title = tt(el.getAttribute('data-i18n-title'));
  });
  updateCrumb();

  const keyInput = document.getElementById('cabKeyInput');
  if (keyInput) keyInput.placeholder = tt('cabKeyPh');

  document.documentElement.lang = lang;
  closeLangDropdown();
  if (currentUser) {
    renderProfile();
    loadPurchases();
  }
}

/* ── Spotlight ── */
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

/* ═════ ОПЛАТА (модальное окно в кабинете) ═════ */
(function () {
  window.openModal = window.openModal || function (key) {
    const el = document.getElementById({ payment: 'modalPayment' }[key]); if (!el) return;
    el.classList.add('open'); document.body.style.overflow = 'hidden';
  };
  window.closeModal = window.closeModal || function (key) {
    document.getElementById({ payment: 'modalPayment' }[key])?.classList.remove('open'); document.body.style.overflow = '';
  };
  window.closeModalOutside = window.closeModalOutside || function (ev, id) {
    if (ev.target.id !== id) return; document.getElementById(id)?.classList.remove('open'); document.body.style.overflow = '';
  };
let selectedPayPlanId   = 'month';
let selectedPayMethodId = 'cryptobot';
let payPromoDiscount    = 0;
let payAppliedPromo     = '';

const CI = n => `https://cdn.jsdelivr.net/npm/cryptocurrency-icons@0.18.1/svg/color/${n}.svg`;
const coin = (n, label) => `<img src="${CI(n)}" width="28" height="28" alt="${label}" loading="lazy" onerror="this.replaceWith(document.createTextNode('${label}'))">`;
const PAY_ICONS = {
  cryptobot: `<svg width="26" height="26" viewBox="0 0 24 24" fill="none"><rect x="2" y="2" width="20" height="20" rx="6" fill="#38bdf8"/><path d="M7 9l5 7 5-7" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  usdt: coin('usdt', 'USDT'),
  btc:  coin('btc', 'BTC'),
  eth:  coin('eth', 'ETH'),
  ltc:  coin('ltc', 'LTC'),
  ton:  `<svg width="28" height="28" viewBox="0 0 56 56"><circle cx="28" cy="28" r="28" fill="#0098EA"/><path d="M37.6 15.6H18.4c-3.5 0-5.7 3.8-4 6.9l11.8 20.5a2.3 2.3 0 004 0l11.8-20.5c1.8-3.1-.4-6.9-3.9-6.9zM25.6 36.4L18.9 22.8c-.4-.7.1-1.6.9-1.6h5.8v15.2zm11.5-13.6l-6.7 13.6V21.2h5.8c.8 0 1.3.9.9 1.6z" fill="#fff"/></svg>`
};

function handleBuy(planId) {
  openPaymentModal(planId || 'month');
}

function openPaymentModal(planId = 'month') {
  const plans = CONFIG.pricing?.plans || [];
  selectedPayPlanId = plans.some(p => p.id === planId) ? planId : (plans[0]?.id || 'month');
  const methods = CONFIG.payment?.methods || [];
  if (!methods.some(m => m.id === selectedPayMethodId)) {
    selectedPayMethodId = methods[0]?.id || 'cryptobot';
  }
  payPromoDiscount = 0;
  payAppliedPromo = '';
  const promoInput = document.getElementById('payPromoInput');
  if (promoInput) promoInput.value = '';

  renderPaymentModal();
  openModal('payment');
}

function selectPayMethod(methodId) {
  selectedPayMethodId = methodId;
  renderPaymentModal();
}

function selectPayPlan(planId) {
  selectedPayPlanId = planId;
  renderPaymentModal();
}

function renderPaymentModal() {
  const methodsGrid = document.getElementById('payMethodsGrid');
  const plansTabs   = document.getElementById('payPlansTabs');
  const titleEl     = document.getElementById('paySummaryTitle');
  const priceEl     = document.getElementById('payTotalPrice');
  const oldPriceEl  = document.getElementById('payTotalOld');
  const funpayBtn   = document.getElementById('payFunpayBtn');
  if (!methodsGrid || !plansTabs) return;

  const methods = CONFIG.payment?.methods || [];
  methodsGrid.innerHTML = methods.map(m => `
    <button type="button" class="pay-method-card ${m.id === selectedPayMethodId ? 'active' : ''}" onclick="selectPayMethod('${m.id}')">
      <span class="pay-method-badge" style="background:${m.badgeColor || '#2563eb'}">${esc(m.badge)}</span>
      <span class="pay-method-ico">${PAY_ICONS[m.id] || '💳'}</span>
      <span class="pay-method-name">${esc(m.name)}</span>
    </button>
  `).join('');

  const plans = CONFIG.pricing?.plans || [];
  const cur   = CONFIG.pricing?.currency || '₽';
  plansTabs.innerHTML = plans.map(p => {
    const dur = p.duration[currentLang] || p.duration.ru;
    return `
      <button type="button" class="pay-plan-tab ${p.id === selectedPayPlanId ? 'active' : ''}" onclick="selectPayPlan('${p.id}')">
        ${esc(dur)}
      </button>
    `;
  }).join('');

  const plan = plans.find(p => p.id === selectedPayPlanId) || plans[0];
  if (plan) {
    const dur = plan.duration[currentLang] || plan.duration.ru;
    const basePrice = Number(plan.price) || 0;
    const finalPrice = payPromoDiscount > 0
      ? Math.max(1, Math.round(basePrice * (1 - payPromoDiscount / 100)))
      : basePrice;

    if (titleEl) titleEl.textContent = `Покупка «${CONFIG.clientName} — ${dur}»`;
    if (priceEl) priceEl.textContent = `${finalPrice} ${cur}`;
    if (oldPriceEl) {
      oldPriceEl.hidden = payPromoDiscount <= 0;
      oldPriceEl.textContent = `${basePrice} ${cur}`;
    }
  }

  if (funpayBtn) {
    funpayBtn.href = CONFIG.payment?.redirectUrls?.[selectedPayPlanId]
      || CONFIG.payment?.funpayUrl
      || 'https://funpay.com/lots/offer?id=78533148';
  }
}

async function applyPayPromo() {
  const input = document.getElementById('payPromoInput');
  const code = (input?.value || '').trim();
  if (!code) {
    payPromoDiscount = 0;
    payAppliedPromo = '';
    renderPaymentModal();
    return;
  }
  try {
    const r = await api('/api/orders/check-promo', { method: 'POST', body: { code, planId: selectedPayPlanId } });
    if (r.valid && Number(r.discount) > 0) {
      payPromoDiscount = Number(r.discount);
      payAppliedPromo = code;
      renderPaymentModal();
      showToast(`Промокод применён: -${payPromoDiscount}%`, 'success');
    } else {
      payPromoDiscount = 0;
      payAppliedPromo = '';
      renderPaymentModal();
      showToast('Промокод не найден или неактивен', 'error');
    }
  } catch (e) {
    showToast(e.message, 'error');
  }
}

async function submitPayment() {
  if (!currentUser) {
    closeModal('payment');
    location.href = '/';
    showToast('Войдите в аккаунт для автоматической выдачи подписки', 'info');
    return;
  }
  const btn = document.getElementById('payContinueBtn');
  if (!btn || btn.classList.contains('loading')) return;

  btn.classList.add('loading');
  try {
    const r = await api('/api/payments/create', {
      method: 'POST',
      body: {
        planId: selectedPayPlanId,
        method: selectedPayMethodId,
        promoCode: payAppliedPromo
      }
    });
    if (r.payUrl) {
      closeModal('payment');
      showToast('Счёт создан. Оплатите в Crypto Bot — подписка выдастся автоматически', 'info');
      watchPayment(r.orderId);
      if (!window.open(r.payUrl, '_blank', 'noopener')) location.href = r.payUrl;
      return;
    }
    showToast(r.message || 'Счёт сформирован', 'success');
    closeModal('payment');
  } catch (err) {
    if (err.status === 401) handleExpired();
    showToast(err.message, 'error');
  } finally {
    btn.classList.remove('loading');
  }
}

function watchPayment(orderId) {
  if (!orderId) return;
  try { localStorage.setItem('snw_order', orderId); } catch {}
  let tries = 0;
  const t = setInterval(async () => {
    if (++tries > 180) { clearInterval(t); return; }          // ~12 минут
    try {
      const r = await api('/api/payments/' + orderId);
      if (r.paid) {
        clearInterval(t);
        try { localStorage.removeItem('snw_order'); } catch {}
        showToast('Оплата получена! Подписка активирована', 'success');
        setTimeout(() => location.reload(), 1200);
      } else if (r.status === 'expired') {
        clearInterval(t);
        try { localStorage.removeItem('snw_order'); } catch {}
        showToast('Счёт истёк', 'error');
      }
    } catch {}
  }, 4000);
}


  window.openPaymentModal = openPaymentModal; window.selectPayMethod = selectPayMethod;
  window.selectPayPlan = selectPayPlan; window.applyPayPromo = applyPayPromo;
  window.submitPayment = submitPayment; window.watchPayment = watchPayment;
})();
document.addEventListener('DOMContentLoaded', () => {
  try { const o = localStorage.getItem('snw_order'); if (o) window.watchPayment(o); } catch {}
});
