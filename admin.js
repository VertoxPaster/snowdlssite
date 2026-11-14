'use strict';
const $ = (s, r = document) => r.querySelector(s), TK = 'vortex_token';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = d => d ? String(d).replace('T', ' ').slice(0, 16) : '—';
const money = n => (+n || 0).toFixed(2) + ' ₽';
let tok = localStorage.getItem(TK), me = null, prods = [], users = [], tab = 'stats';

async function api(p, m = 'GET', b) {
  const r = await fetch(p, { method: m, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: b ? JSON.stringify(b) : undefined });
  let j = {}; try { j = await r.json(); } catch {}
  if (!r.ok) throw Object.assign(new Error(j.message || 'Ошибка ' + r.status), { status: r.status });
  return j;
}
function toast(t, bad) { const d = document.createElement('div'); d.textContent = t; if (bad) d.className = 'e'; $('#toast').append(d); setTimeout(() => d.remove(), 4000); }
const act = async (fn, ok) => { try { const r = await fn(); if (ok) toast(ok); return r; } catch (e) { toast(e.message, true); if (e.status === 403 || e.status === 401) boot(); } };
const view = h => { $('#app').innerHTML = h; };
function logout() { api('/api/auth/logout', 'POST').catch(() => {}); localStorage.removeItem(TK); tok = null; boot(); }

// ---------- экраны входа
function loginScreen() {
  view(`<div class="center"><form class="box" id="f"><h1>Вход в админку</h1><input name="i" placeholder="Email или ник" autocomplete="username" required><input name="p" type="password" placeholder="Пароль" autocomplete="current-password" required><button>Войти</button></form></div>`);
  $('#f').onsubmit = async e => {
    e.preventDefault(); const f = e.target;
    const r = await act(() => api('/api/auth/login', 'POST', { email: f.i.value, password: f.p.value }));
    if (r) { tok = r.token; localStorage.setItem(TK, tok); boot(); }
  };
}
function codeScreen() {
  view(`<div class="center"><form class="box" id="f"><h1>Подтверждение 2FA</h1><p class="mut">Код из приложения-аутентификатора или резервный код.</p><input name="c" inputmode="numeric" autocomplete="one-time-code" placeholder="123456" required autofocus><button>Подтвердить</button><button type="button" class="g" id="out">Выйти</button></form></div>`);
  $('#out').onclick = logout;
  $('#f').onsubmit = async e => { e.preventDefault(); if (await act(() => api('/api/admin/2fa/verify', 'POST', { code: e.target.c.value }))) boot(); };
}
async function setupScreen(first = true) {
  const r = await act(() => api('/api/admin/2fa/setup', 'POST'));
  if (!r) return;
  view(`<div class="center"><form class="box" id="f"><h1>Включите 2FA</h1><p class="mut">${first ? 'Без 2FA админка закрыта. ' : ''}Добавьте ключ в Google Authenticator / Aegis / 1Password (ввод вручную, тип «по времени»).</p>
  <label>Секретный ключ<span class="mono">${esc(r.secret)}</span></label><a href="${esc(r.uri)}">Открыть в приложении на телефоне</a>
  <input name="c" inputmode="numeric" placeholder="Код из приложения" required><button>Включить</button><button type="button" class="g" id="out">Выйти</button></form></div>`);
  $('#out').onclick = logout;
  $('#f').onsubmit = async e => {
    e.preventDefault();
    const j = await act(() => api('/api/admin/2fa/enable', 'POST', { code: e.target.c.value }));
    if (j) { view(`<div class="center"><div class="box"><h1>Резервные коды</h1><p class="mut">Сохраните — покажутся один раз. Каждый код работает один раз, если потеряете телефон.</p><div class="mono" style="line-height:2">${j.backup_codes.map(esc).join('<br>')}</div><button id="ok">Я сохранил, продолжить</button></div></div>`); $('#ok').onclick = boot; }
  };
}

// ---------- панель
const TABS = { stats: 'Обзор', users: 'Пользователи', keys: 'Ключи', purchases: 'Покупки', audit: 'Журнал', sec: 'Безопасность' };
function panel() {
  view(`<div class="layout"><nav><b>⚙ Админка</b>${Object.entries(TABS).map(([k, v]) => `<button data-t="${k}" class="${k === tab ? 'on' : ''}">${v}</button>`).join('')}<button id="out">Выйти</button></nav><main id="m"></main></div>`);
  document.querySelectorAll('nav [data-t]').forEach(b => b.onclick = () => { tab = b.dataset.t; panel(); });
  $('#out').onclick = logout;
  ({ stats, users: usersTab, keys: keysTab, purchases, audit, sec })[tab]();
}
const table = (heads, rows) => `<div class="tw"><table><tr>${heads.map(h => `<th>${h}</th>`).join('')}</tr>${rows.join('') || `<tr><td colspan="${heads.length}" class="mut">Пусто</td></tr>`}</table></div>`;

async function stats() {
  const r = await act(() => api('/api/admin/stats')); if (!r) return; const d = r.data;
  const c = (t, v) => `<div class="stat"><span class="mut">${t}</span><b>${esc(v)}</b></div>`;
  $('#m').innerHTML = `<h2>Обзор</h2><div class="cards">${c('Пользователей', d.users)}${c('Новых за 7 дней', d.new_week)}${c('Сумма балансов', money(d.balance))}${c('Покупок', d.purchases)}${c('Ключей всего', d.keys_total)}${c('Ключей использовано', d.keys_used)}</div><div class="stat"><span class="mut">Роли</span><br>${Object.entries(d.roles).map(([k, v]) => `<span class="tag">${esc(k)}: ${esc(v)}</span> `).join('')}</div>`;
}

async function usersTab() {
  const r = await act(() => api('/api/admin/users')); if (!r) return; users = r.data;
  $('#m').innerHTML = `<h2>Пользователи (${users.length})</h2><div class="bar"><input id="q" placeholder="Поиск: ник, email, id"></div><div id="t"></div>`;
  const draw = () => {
    const q = $('#q').value.toLowerCase();
    $('#t').innerHTML = table(['ID', 'Ник', 'Email', 'Роль', 'Баланс', 'Покупок', 'Создан', ''], users.filter(u => !q || [u.id, u.username, u.email].join(' ').toLowerCase().includes(q)).map(u =>
      `<tr><td>${u.id}</td><td>${esc(u.username)} ${u.banned ? '<span class="tag ban">бан</span>' : ''}</td><td>${esc(u.email)}</td><td><span class="tag ${u.role === 'admin' ? 'admin' : ''}">${esc(u.role)}</span></td><td>${money(u.balance)}</td><td>${u.purchases}</td><td>${fmt(u.created_at)}</td><td><button class="s g" data-u="${u.id}">Открыть</button></td></tr>`));
    document.querySelectorAll('[data-u]').forEach(b => b.onclick = () => userDlg(users.find(x => x.id == b.dataset.u)));
  };
  $('#q').oninput = draw; draw();
}
async function userDlg(u) {
  if (!prods.length) prods = (await act(() => api('/api/admin/products')))?.data || [];
  const isA = u.role === 'admin', d = $('#dlg');
  d.innerHTML = `<form method="dialog" class="stack" id="uf"><h2>${esc(u.username)} <span class="mut">#${u.id}</span></h2>
  ${isA ? '<p class="mut">Это админ — менять другого админа нельзя.</p>' : `
  <div class="row"><label>Ник<input name="username" value="${esc(u.username)}"></label><label>Email<input name="email" value="${esc(u.email)}"></label></div>
  <div class="row"><label>Роль<select name="role">${['user', 'beta_tester', 'moderator', 'admin'].map(r => `<option ${r === u.role ? 'selected' : ''}>${r}</option>`).join('')}</select></label><label>Баланс (установить)<input name="balance" type="number" step="0.01" value="${u.balance}"></label></div>
  <label>Новый пароль (мин. 8, пусто = не менять)<input name="password" type="password" autocomplete="new-password"></label><button data-a="save">Сохранить</button>`}
  <div class="row"><label>Начислить ₽<input id="amt" type="number" step="0.01"></label><button class="g" data-a="grant" style="align-self:end">Начислить</button></div>
  <div class="row"><label>Выдать товар<select id="prod">${prods.map(p => `<option value="${esc(p.id)}">${esc(p.title)}</option>`).join('')}</select></label><button class="g" data-a="gprod" style="align-self:end">Выдать</button></div>
  <div class="row"><label>Выдать косметику (ID)<input id="cos" type="number"></label><button class="g" data-a="gcos" style="align-self:end">Выдать</button></div>
  <div class="row"><button class="g" data-a="kick">Завершить сессии</button>${isA ? '' : `<button class="g" data-a="ban">${u.banned ? 'Разбанить' : 'Забанить'}</button><button class="d" data-a="del">Удалить</button>`}</div>
<div class="row">
    <label>HWID<input value="${esc(u.hwid || 'Не привязан')}" readonly></label>
    ${u.hwid ? `<button class="g" data-a="rhwid" style="align-self:end">Сбросить HWID</button>` : ''}
  </div>
  <button class="g" data-a="x">Закрыть</button></form>`;
  d.showModal();
  d.querySelectorAll('[data-a]').forEach(b => b.onclick = async e => {
    e.preventDefault(); const a = b.dataset.a, id = u.id, f = $('#uf');
    if (a === 'x') return d.close();
    let r;
    if (a === 'save') { const body = { userId: id }; ['username', 'email', 'role', 'balance', 'password'].forEach(k => { if (f[k].value !== '') body[k] = f[k].value; }); r = await act(() => api('/api/admin/users/update', 'POST', body), 'Сохранено'); }
    if (a === 'grant') r = await act(() => api('/api/admin/users/grant', 'POST', { userId: id, amount: $('#amt').value }), 'Начислено');
    if (a === 'rhwid') r = await act(() => api('/api/admin/users/update', 'POST', { userId: id, reset_hwid: true }), 'HWID сброшен');
    if (a === 'gprod') r = await act(() => api('/api/admin/users/grant', 'POST', { userId: id, productId: $('#prod').value }), 'Товар выдан');
    if (a === 'gcos') r = await act(() => api('/api/admin/users/grant', 'POST', { userId: id, cosmeticId: $('#cos').value }), 'Косметика выдана');
    if (a === 'kick') r = await act(() => api('/api/admin/users/logout', 'POST', { userId: id }), 'Сессии завершены');
    if (a === 'ban') r = await act(() => api('/api/admin/users/ban', 'POST', { userId: id, banned: !u.banned }), 'Готово');
    if (a === 'del') { if (!confirm('Удалить ' + u.username + ' безвозвратно?')) return; r = await act(() => api('/api/admin/users/delete', 'POST', { userId: id }), 'Удалён'); }
    if (r) { d.close(); usersTab(); }
  });
}

async function keysTab() {
  if (!prods.length) prods = (await act(() => api('/api/admin/products')))?.data || [];
  const r = await act(() => api('/api/admin/keys')); if (!r) return;
  $('#m').innerHTML = `<h2>Ключи</h2><div class="bar"><select id="kp">${prods.map(p => `<option value="${esc(p.id)}">${esc(p.title)}</option>`).join('')}</select><input id="kn" type="number" min="1" max="100" value="1" style="max-width:90px"><button id="kg">Создать</button></div><div id="kout" class="stack" style="margin-bottom:14px"></div><div id="t"></div>`;
  $('#t').innerHTML = table(['Ключ', 'Товар', 'Создан', 'Использован', ''], r.data.map(k => `<tr><td><code>${esc(k.key)}</code></td><td>${esc(k.product_title)}</td><td>${fmt(k.created_at)}</td><td>${k.used_by ? 'user #' + esc(k.used_by) + ' · ' + fmt(k.used_at) : '—'}</td><td>${k.used_by ? '' : `<button class="s d" data-k="${esc(k.key)}">Удалить</button>`}</td></tr>`));
  document.querySelectorAll('[data-k]').forEach(b => b.onclick = async () => { if (await act(() => api('/api/admin/keys/delete', 'POST', { key: b.dataset.k }), 'Удалён')) keysTab(); });
  $('#kg').onclick = async () => {
    const j = await act(() => api('/api/admin/keys', 'POST', { productId: $('#kp').value, count: +$('#kn').value || 1 }));
    if (j) { keysTab(); setTimeout(() => { $('#kout').innerHTML = `<div class="mono">${j.keys.map(esc).join('<br>')}</div>`; }, 300); }
  };
}
async function purchases() {
  const r = await act(() => api('/api/admin/purchases')); if (!r) return;
  $('#m').innerHTML = '<h2>Последние покупки</h2>' + table(['ID', 'Пользователь', 'Товар', 'Цена', 'Источник', 'Дата', 'Истекает'], r.data.map(p => `<tr><td>${p.id}</td><td>${esc(p.username)}</td><td>${esc(p.title)}</td><td>${money(p.price)}</td><td>${esc(p.source)}</td><td>${fmt(p.purchased_at)}</td><td>${fmt(p.expires_at)}</td></tr>`));
}
async function audit() {
  const r = await act(() => api('/api/admin/audit')); if (!r) return;
  $('#m').innerHTML = '<h2>Журнал действий админов</h2>' + table(['Время', 'Админ', 'Действие', 'Детали'], r.data.map(a => `<tr><td>${fmt(a.ts)}</td><td>${esc(a.admin_name)}</td><td>${esc(a.action)}</td><td>${esc(a.detail)}</td></tr>`));
}
function sec() {
  $('#m').innerHTML = `<h2>Безопасность</h2><form class="box stack" id="f" style="max-width:420px"><b>2FA включена ✓</b><p class="mut">Сессия админки живёт 8 часов, дальше нужен код заново. Чтобы отключить 2FA — пароль и текущий код.</p><input name="p" type="password" placeholder="Пароль" autocomplete="current-password" required><input name="c" inputmode="numeric" placeholder="Код 2FA" required><button class="d">Отключить 2FA</button></form>`;
  $('#f').onsubmit = async e => { e.preventDefault(); if (!confirm('Отключить 2FA? Админка закроется, пока не включите снова.')) return; if (await act(() => api('/api/admin/2fa/disable', 'POST', { password: e.target.p.value, code: e.target.c.value }), '2FA отключена')) boot(); };
}

async function boot() {
  if (!tok) return loginScreen();
  try { me = (await api('/api/auth/me')).user; } catch { localStorage.removeItem(TK); tok = null; return loginScreen(); }
  if (me.role !== 'admin') { view('<div class="center"><div class="box"><h1>Нет доступа</h1><p class="mut">Этот аккаунт не админ.</p><button id="out">Выйти</button></div></div>'); return $('#out').onclick = logout; }
  const s = await act(() => api('/api/admin/2fa/status')); if (!s) return;
  if (!s.enabled) return setupScreen();
  if (!s.verified) return codeScreen();
  panel();
}
boot();
