'use strict';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const TK = 'vortex_token', T0 = 'vortex_t0';
const IDLE_MS = 15 * 60e3, SESSION_MS = 8 * 3600e3;
const ROLES = ['user', 'beta_tester', 'moderator', 'admin'];
const TABS = { stats: 'Обзор', users: 'Пользователи', keys: 'Ключи', purchases: 'Покупки', audit: 'Журнал', sec: 'Безопасность' };

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = d => d ? String(d).replace('T', ' ').slice(0, 16) : '—';
const money = n => (+n || 0).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ₽';
const debounce = (f, ms = 150) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => f(...a), ms); }; };

// Токен живёт только в sessionStorage: закрыл вкладку — вышел. Старый токен из localStorage удаляем.
const ss = {
  get: k => { try { return sessionStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { sessionStorage.setItem(k, v); } catch {} },
  del: k => { try { sessionStorage.removeItem(k); } catch {} }
};
try { localStorage.removeItem(TK); } catch {}

let tok = ss.get(TK), me = null, prods = [], users = [], navId = 0, tick = null, last = Date.now();
let tab = TABS[location.hash.slice(1)] ? location.hash.slice(1) : 'stats';
let refreshUsers = null, refreshKeys = null, lastKeys = [];
const sel = new Set();

// ---------- сеть
async function api(p, m = 'GET', b) {
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), 20000);
  try {
    const r = await fetch(p, {
      method: m, signal: ac.signal, cache: 'no-store',
      headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) },
      body: b ? JSON.stringify(b) : undefined
    });
    let j = {}; try { j = await r.json(); } catch {}
    if (!r.ok) throw Object.assign(new Error(j.message || (r.status === 429 ? 'Слишком много запросов, подождите' : 'Ошибка ' + r.status)), { status: r.status });
    return j;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Сервер не отвечает (таймаут)');
    if (e instanceof TypeError) throw new Error('Нет связи с сервером');
    throw e;
  } finally { clearTimeout(t); }
}
function toast(t, bad) {
  const box = $('#toast'), d = document.createElement('div');
  d.textContent = t; if (bad) d.className = 'e';
  box.append(d); while (box.children.length > 5) box.firstChild.remove();
  setTimeout(() => d.remove(), 4500);
}
// btn блокируется на время запроса — защита от двойных кликов (двойное начисление и т.п.)
const act = async (fn, ok, btn) => {
  if (btn) { if (btn.disabled) return; btn.disabled = true; }
  try { const r = await fn(); if (ok) toast(ok); return r; }
  catch (e) {
    toast(e.message, true);
    if (e.status === 401) forget('Сессия истекла, войдите заново');
    else if (e.status === 403) boot();
  } finally { if (btn) btn.disabled = false; }
};
const view = h => { $('#app').innerHTML = h; };

// ---------- утилиты
async function copy(text, msg = 'Скопировано') {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const t = document.createElement('textarea'); t.value = text; t.style.cssText = 'position:fixed;opacity:0';
    document.body.append(t); t.select(); try { document.execCommand('copy'); } catch {} t.remove();
  }
  toast(msg);
}
function saveFile(name, text, type = 'text/plain') {
  const a = document.createElement('a'), u = URL.createObjectURL(new Blob(['\ufeff' + text], { type: type + ';charset=utf-8' }));
  a.href = u; a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 1000);
}
// CSV с защитой от formula-injection (=, +, -, @ в начале ячейки)
const csvCell = v => { if (typeof v === 'number') return v; let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
const exportCsv = (name, heads, rows) => saveFile(name + '_' + new Date().toISOString().slice(0, 10) + '.csv', [heads, ...rows].map(r => r.map(csvCell).join(';')).join('\r\n'), 'text/csv');

// Универсальная таблица: сортировка по клику на заголовок, пагинация, делегирование событий
function grid(el, cols, o = {}) {
  let rows = [], sk = o.sort ?? -1, sd = o.dir ?? -1, pg = 0;
  const size = o.size || 25;
  const draw = () => {
    const c = cols[sk];
    const list = c?.s ? [...rows].sort((a, b) => { const x = c.s(a), y = c.s(b); return (x > y ? 1 : x < y ? -1 : 0) * sd; }) : rows;
    const pages = Math.max(1, Math.ceil(list.length / size)); pg = Math.min(pg, pages - 1);
    const body = list.slice(pg * size, (pg + 1) * size).map(r => `<tr>${cols.map(c => `<td${c.c ? ` class="${c.c}"` : ''}>${c.v(r)}</td>`).join('')}</tr>`).join('');
    el.innerHTML = `<div class="tw"><table><tr>${cols.map((c, i) => `<th${c.s ? ` class="sort" data-s="${i}"` : ''}>${c.h}${sk === i ? (sd > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('')}</tr>${body || `<tr><td colspan="${cols.length}" class="mut">Ничего не найдено</td></tr>`}</table></div>` +
      (pages > 1 ? `<div class="pager"><button class="g s" data-p="-1" ${pg ? '' : 'disabled'}>←</button><span class="mut">${pg + 1} / ${pages} · ${list.length}</span><button class="g s" data-p="1" ${pg < pages - 1 ? '' : 'disabled'}>→</button></div>` : '');
    o.after?.(list);
  };
  el.addEventListener('click', e => {
    const th = e.target.closest('[data-s]');
    if (th) { const i = +th.dataset.s; sd = sk === i ? -sd : 1; sk = i; return draw(); }
    const p = e.target.closest('[data-p]');
    if (p) { pg += +p.dataset.p; draw(); }
  });
  return { set(r, keep) { rows = r; if (!keep) pg = 0; draw(); } };
}
const opts = (arr, all) => (all ? `<option value="">${all}</option>` : '') + arr.map(x => `<option value="${esc(x)}">${esc(x)}</option>`).join('');

// ---------- сессия: автовыход при бездействии и по истечении 8 часов
['mousemove', 'keydown', 'click', 'touchstart', 'scroll'].forEach(ev => addEventListener(ev, () => { last = Date.now(); }, { passive: true }));
addEventListener('keydown', e => {
  if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) && $('#q')) { e.preventDefault(); $('#q').focus(); }
});
function startTimers() {
  clearInterval(tick);
  if (!ss.get(T0)) ss.set(T0, Date.now());
  last = Date.now();
  const check = () => {
    if (!tok) return clearInterval(tick);
    const left = SESSION_MS - (Date.now() - +ss.get(T0));
    if (Date.now() - last > IDLE_MS) return logout('Выход из-за бездействия (15 мин)');
    if (left <= 0) return logout('Сессия истекла (8 ч)');
    const el = $('#ses'); if (el) el.textContent = `Сессия ещё ${Math.floor(left / 3.6e6)} ч ${Math.floor(left % 3.6e6 / 6e4)} мин`;
  };
  tick = setInterval(check, 15000); check();
}
function forget(msg) {
  clearInterval(tick); ss.del(TK); ss.del(T0); tok = null; me = null; prods = []; users = []; lastKeys = []; sel.clear();
  const d = $('#dlg'); if (d?.open) d.close();
  boot().then(() => msg && toast(msg));
}
function logout(msg) { api('/api/auth/logout', 'POST').catch(() => {}); forget(msg); }

// ---------- экраны входа
let fails = 0, lockUntil = 0;
function loginScreen() {
  view(`<div class="center"><form class="box" id="f"><h1>Вход в админку</h1><input name="i" placeholder="Email или ник" autocomplete="username" required autofocus><input name="p" type="password" placeholder="Пароль" autocomplete="current-password" required><label class="chk"><input type="checkbox" id="sp"> Показать пароль</label><button id="go">Войти</button></form></div>`);
  $('#sp').onchange = e => { $('#f').p.type = e.target.checked ? 'text' : 'password'; };
  $('#f').onsubmit = async e => {
    e.preventDefault(); const f = e.target;
    const wait = Math.ceil((lockUntil - Date.now()) / 1000);
    if (wait > 0) return toast(`Слишком много попыток. Подождите ${wait} с`, true);
    const r = await act(() => api('/api/auth/login', 'POST', { email: f.i.value.trim(), password: f.p.value }), null, $('#go'));
    if (r?.token) { fails = 0; tok = r.token; ss.set(TK, tok); ss.set(T0, Date.now()); boot(); }
    else { f.p.value = ''; if (++fails >= 5) { fails = 0; lockUntil = Date.now() + 30000; toast('5 неудачных попыток — пауза 30 секунд', true); } }
  };
}
function codeScreen() {
  view(`<div class="center"><form class="box" id="f"><h1>Подтверждение 2FA</h1><p class="mut">Код из приложения-аутентификатора или резервный код.</p><input name="c" inputmode="numeric" autocomplete="one-time-code" placeholder="123456" required autofocus><button id="go">Подтвердить</button><button type="button" class="g" id="out">Выйти</button></form></div>`);
  $('#out').onclick = () => logout();
  $('#f').onsubmit = async e => {
    e.preventDefault();
    const c = e.target.c.value.trim(); if (!c) return;
    if (await act(() => api('/api/admin/2fa/verify', 'POST', { code: c }), null, $('#go'))) { ss.set(T0, Date.now()); boot(); }
    else e.target.c.select();
  };
}
async function setupScreen(first = true) {
  const r = await act(() => api('/api/admin/2fa/setup', 'POST'));
  if (!r) return;
  view(`<div class="center"><form class="box" id="f"><h1>Включите 2FA</h1><p class="mut">${first ? 'Без 2FA админка закрыта. ' : ''}Добавьте ключ в Google Authenticator / Aegis / 1Password (ввод вручную, тип «по времени»).</p>
  <label>Секретный ключ<span class="mono">${esc(r.secret)}</span></label><div class="row"><button type="button" class="g s" id="cs">Скопировать ключ</button><a href="${esc(r.uri)}" style="align-self:center">Открыть в приложении</a></div>
  <input name="c" inputmode="numeric" placeholder="Код из приложения" required autocomplete="off"><button id="go">Включить</button><button type="button" class="g" id="out">Выйти</button></form></div>`);
  $('#cs').onclick = () => copy(r.secret, 'Ключ скопирован');
  $('#out').onclick = () => logout();
  $('#f').onsubmit = async e => {
    e.preventDefault();
    const j = await act(() => api('/api/admin/2fa/enable', 'POST', { code: e.target.c.value.trim() }), null, $('#go'));
    if (!j) return;
    const codes = j.backup_codes.join('\n');
    view(`<div class="center"><div class="box"><h1>Резервные коды</h1><p class="mut">Сохраните — покажутся один раз. Каждый код работает один раз, если потеряете телефон.</p><div class="mono" style="line-height:2">${j.backup_codes.map(esc).join('<br>')}</div>
    <div class="row"><button class="g s" id="cc">Копировать</button><button class="g s" id="dc">Скачать .txt</button></div>
    <label class="chk"><input type="checkbox" id="sv"> Я сохранил коды в надёжном месте</label><button id="ok" disabled>Продолжить</button></div></div>`);
    $('#cc').onclick = () => copy(codes, 'Коды скопированы');
    $('#dc').onclick = () => saveFile('backup-codes.txt', codes);
    $('#sv').onchange = ev => { $('#ok').disabled = !ev.target.checked; };
    $('#ok').onclick = () => boot();
  };
}

// ---------- панель
function panel() {
  const n = ++navId;
  history.replaceState(null, '', '#' + tab);
  view(`<div class="layout"><nav><b>⚙ Админка</b><div class="me">${esc(me.username || me.email || '')}</div>${Object.entries(TABS).map(([k, v]) => `<button data-t="${k}" class="${k === tab ? 'on' : ''}" ${k === tab ? 'aria-current="page"' : ''}>${v}</button>`).join('')}<div id="ses"></div><button id="out">Выйти</button></nav><main id="m"><p class="mut">Загрузка…</p></main></div>`);
  $$('nav [data-t]').forEach(b => b.onclick = () => { tab = b.dataset.t; panel(); });
  $('#out').onclick = () => logout();
  startTimers();
  if (n === navId) ({ stats, users: usersTab, keys: keysTab, purchases, audit, sec })[tab]();
}

async function stats() {
  const n = navId, r = await act(() => api('/api/admin/stats')); if (!r || n !== navId) return;
  const d = r.data, free = d.keys_total - d.keys_used, pct = d.keys_total ? Math.round(d.keys_used / d.keys_total * 100) : 0;
  const c = (t, v, s = '') => `<div class="stat"><span class="mut">${t}</span><b>${esc(v)}</b>${s ? `<span class="mut">${esc(s)}</span>` : ''}</div>`;
  $('#m').innerHTML = `<div class="head"><h2>Обзор</h2><button class="g s" id="rf">↻ Обновить</button></div><div class="cards">${c('Пользователей', d.users)}${c('Новых за 7 дней', d.new_week)}${c('Сумма балансов', money(d.balance))}${c('Покупок', d.purchases)}${c('Ключей всего', d.keys_total)}${c('Ключей использовано', d.keys_used, pct + '%')}${c('Ключей свободно', free)}</div><div class="stat"><span class="mut">Роли</span><br>${Object.entries(d.roles || {}).map(([k, v]) => `<span class="tag ${k === 'admin' ? 'admin' : ''}">${esc(k)}: ${esc(v)}</span> `).join('')}</div>`;
  $('#rf').onclick = stats;
}

// ---------- пользователи
async function usersTab() {
  const n = navId;
  $('#m').innerHTML = `<div class="head"><h2>Пользователи <span class="mut" id="cnt"></span></h2><div class="bar" style="margin:0"><button class="g s" id="ex">CSV</button><button class="g s" id="rf">↻</button></div></div>
  <div class="bar"><input id="q" placeholder="Поиск: ник, email, id  ( / )" autocomplete="off"><select id="fr">${opts(ROLES, 'Все роли')}</select><select id="fs"><option value="">Все</option><option value="ok">Активные</option><option value="ban">Забаненные</option></select></div><div id="t"></div>`;
  let cur = [];
  const g = grid($('#t'), [
    { h: 'ID', v: u => u.id, s: u => +u.id },
    { h: 'Ник', v: u => `<a href="#" data-u="${u.id}">${esc(u.username)}</a> ${u.banned ? '<span class="tag ban">бан</span>' : ''}`, s: u => String(u.username).toLowerCase() },
    { h: 'Email', v: u => esc(u.email), s: u => String(u.email).toLowerCase() },
    { h: 'Роль', v: u => `<span class="tag ${u.role === 'admin' ? 'admin' : ''}">${esc(u.role)}</span>`, s: u => u.role },
    { h: 'Баланс', v: u => money(u.balance), s: u => +u.balance },
    { h: 'Покупок', v: u => u.purchases, s: u => +u.purchases },
    { h: 'Создан', v: u => fmt(u.created_at), s: u => String(u.created_at) },
    { h: '', v: u => `<button class="s g" data-u="${u.id}">Открыть</button>` }
  ], { sort: 0, dir: -1, after: l => { cur = l; $('#cnt').textContent = `${l.length} из ${users.length}`; } });
  const draw = (keep) => {
    const q = $('#q').value.trim().toLowerCase(), ro = $('#fr').value, st = $('#fs').value;
    g.set(users.filter(u => (!q || [u.id, u.username, u.email].join(' ').toLowerCase().includes(q)) && (!ro || u.role === ro) && (!st || (st === 'ban') === !!u.banned)), keep);
  };
  const load = async () => { const r = await act(() => api('/api/admin/users')); if (!r || n !== navId) return; users = r.data; draw(true); };
  refreshUsers = load;
  $('#q').oninput = debounce(() => draw()); $('#fr').onchange = $('#fs').onchange = () => draw();
  $('#rf').onclick = load;
  $('#ex').onclick = () => exportCsv('users', ['ID', 'Ник', 'Email', 'Роль', 'Баланс', 'Покупок', 'Забанен', 'Создан'], cur.map(u => [+u.id, u.username, u.email, u.role, +u.balance, +u.purchases, u.banned ? 'да' : 'нет', u.created_at]));
  $('#t').addEventListener('click', e => { const a = e.target.closest('[data-u]'); if (a) { e.preventDefault(); userDlg(users.find(x => x.id == a.dataset.u)); } });
  await load();
}

async function userDlg(u) {
  if (!u) return;
  if (!prods.length) prods = (await act(() => api('/api/admin/products')))?.data || [];
  const isA = u.role === 'admin', d = $('#dlg');
  d.onclose = () => { d.innerHTML = ''; };
  d.innerHTML = `<form class="stack" id="uf" novalidate>
  <div class="head"><h2>${esc(u.username)} <span class="mut">#${u.id}</span> ${u.banned ? '<span class="tag ban">бан</span>' : ''}</h2><button type="button" class="g s" data-a="x" aria-label="Закрыть">✕</button></div>
  <div class="mut">${esc(u.email)} · баланс ${money(u.balance)} · покупок ${u.purchases} · с ${fmt(u.created_at)}</div>
  <div class="row"><button type="button" class="g s" data-a="cid">Копировать ID</button><button type="button" class="g s" data-a="cem">Копировать email</button></div><hr>
  ${isA ? '<p class="mut">Это админ — менять другого админа нельзя.</p>' : `
  <div class="row"><label>Ник<input name="username" value="${esc(u.username)}" maxlength="64" autocomplete="off"></label><label>Email<input name="email" value="${esc(u.email)}" maxlength="254" autocomplete="off"></label></div>
  <div class="row"><label>Роль<select name="role">${ROLES.map(r => `<option ${r === u.role ? 'selected' : ''}>${r}</option>`).join('')}</select></label><label>Баланс (установить)<input name="balance" type="number" step="0.01" value="${esc(u.balance)}"></label></div>
  <label>Новый пароль (мин. 8, пусто = не менять)<input name="password" type="password" autocomplete="new-password"></label><button type="button" data-a="save">Сохранить изменения</button><hr>`}
  <div class="row"><label>Начислить ₽<input id="amt" type="number" step="0.01"></label><button type="button" class="g" data-a="grant" style="align-self:end">Начислить</button></div>
  <div class="row"><label>Выдать товар<select id="prod">${prods.map(p => `<option value="${esc(p.id)}">${esc(p.title)}</option>`).join('')}</select></label><button type="button" class="g" data-a="gprod" style="align-self:end" ${prods.length ? '' : 'disabled'}>Выдать</button></div>
  <div class="row"><label>Выдать косметику (ID)<input id="cos" type="number" min="1" step="1"></label><button type="button" class="g" data-a="gcos" style="align-self:end">Выдать</button></div>
  <div class="row"><label>HWID<input value="${esc(u.hwid || 'Не привязан')}" readonly></label>${u.hwid ? `<button type="button" class="g" data-a="rhwid" style="align-self:end">Сбросить HWID</button>` : ''}</div><hr>
  <div class="row"><button type="button" class="g" data-a="kick">Завершить сессии</button>${isA ? '' : `<button type="button" class="g" data-a="ban">${u.banned ? 'Разбанить' : 'Забанить'}</button><button type="button" class="d" data-a="del">Удалить</button>`}</div>
  </form>`;
  if (!d.open) d.showModal();
  const f = $('#uf'), val = k => f.elements[k]?.value ?? '';
  f.onsubmit = e => { e.preventDefault(); f.querySelector('[data-a=save]')?.click(); };
  f.onclick = async e => {
    const b = e.target.closest('[data-a]'); if (!b) return;
    e.preventDefault();
    const a = b.dataset.a, id = u.id, bad = m => toast(m, true);
    let r, stay = true;
    if (a === 'x') return d.close();
    if (a === 'cid') return copy(String(id), 'ID скопирован');
    if (a === 'cem') return copy(u.email, 'Email скопирован');
    if (a === 'save') {
      const body = { userId: id }, ch = [];
      const un = val('username').trim(), em = val('email').trim(), ro = val('role'), ba = val('balance'), pw = val('password');
      if (!un) return bad('Ник не может быть пустым');
      if (un !== u.username) { body.username = un; ch.push(`ник: ${u.username} → ${un}`); }
      if (!/^\S+@\S+\.\S+$/.test(em)) return bad('Некорректный email');
      if (em !== u.email) { body.email = em; ch.push(`email: ${u.email} → ${em}`); }
      if (ro !== u.role) { body.role = ro; ch.push(`РОЛЬ: ${u.role} → ${ro}${ro === 'admin' ? '  (!!! права администратора)' : ''}`); }
      if (ba !== '' && +ba !== +u.balance) {
        if (!isFinite(+ba) || +ba < 0) return bad('Некорректный баланс');
        body.balance = ba; ch.push(`баланс: ${money(u.balance)} → ${money(ba)}`);
      }
      if (pw) { if (pw.length < 8) return bad('Пароль минимум 8 символов'); body.password = pw; ch.push('новый пароль'); }
      if (!ch.length) return toast('Изменений нет');
      if (!confirm('Применить изменения?\n\n• ' + ch.join('\n• '))) return;
      r = await act(() => api('/api/admin/users/update', 'POST', body), 'Сохранено', b); stay = false;
    }
    if (a === 'grant') {
      const raw = $('#amt').value, n = +raw;
      if (!raw || !isFinite(n) || n === 0) return bad('Введите сумму (не 0)');
      if (!confirm(`${n > 0 ? 'Начислить' : 'Списать'} ${money(Math.abs(n))} — ${u.username}?`)) return;
      r = await act(() => api('/api/admin/users/grant', 'POST', { userId: id, amount: raw }), 'Готово', b);
    }
    if (a === 'gprod') {
      const pid = $('#prod').value, title = $('#prod').selectedOptions[0]?.text;
      if (!pid) return bad('Выберите товар');
      if (!confirm(`Выдать «${title}» пользователю ${u.username}?`)) return;
      r = await act(() => api('/api/admin/users/grant', 'POST', { userId: id, productId: pid }), 'Товар выдан', b);
    }
    if (a === 'gcos') {
      const cid = $('#cos').value;
      if (!/^\d+$/.test(cid) || +cid < 1) return bad('Введите корректный ID косметики');
      if (!confirm(`Выдать косметику #${cid} пользователю ${u.username}?`)) return;
      r = await act(() => api('/api/admin/users/grant', 'POST', { userId: id, cosmeticId: cid }), 'Косметика выдана', b);
    }
    if (a === 'rhwid') { if (!confirm('Сбросить HWID? Пользователь сможет привязать новое устройство.')) return; r = await act(() => api('/api/admin/users/update', 'POST', { userId: id, reset_hwid: true }), 'HWID сброшен', b); }
    if (a === 'kick') { if (!confirm('Завершить все сессии ' + u.username + '?')) return; r = await act(() => api('/api/admin/users/logout', 'POST', { userId: id }), 'Сессии завершены', b); }
    if (a === 'ban') { if (!confirm(`${u.banned ? 'Разбанить' : 'Забанить'} ${u.username}?`)) return; r = await act(() => api('/api/admin/users/ban', 'POST', { userId: id, banned: !u.banned }), 'Готово', b); stay = false; }
    if (a === 'del') {
      const t = prompt(`Удаление необратимо.\nДля подтверждения введите ник: ${u.username}`);
      if (t === null) return;
      if (t.trim() !== u.username) return bad('Ник не совпал — удаление отменено');
      r = await act(() => api('/api/admin/users/delete', 'POST', { userId: id }), 'Удалён', b); stay = false;
    }
    if (!r) return;
    await refreshUsers?.();
    const fresh = users.find(x => x.id == id);
    if (stay && fresh) userDlg(fresh); else d.close();
  };
}

// ---------- ключи
async function keysTab() {
  const n = navId;
  if (!prods.length) prods = (await act(() => api('/api/admin/products')))?.data || [];
  if (n !== navId) return;
  const titles = prods.map(p => p.title);
  $('#m').innerHTML = `<h2>Ключи <span class="mut" id="cnt"></span></h2>
  <div class="box stack" style="margin-bottom:14px"><b>Создать ключи</b><div class="bar" style="margin:0"><select id="kp">${prods.map(p => `<option value="${esc(p.id)}">${esc(p.title)}</option>`).join('')}</select><input id="kn" type="number" min="1" max="100" value="1" style="max-width:90px"><button id="kg" ${prods.length ? '' : 'disabled'}>Создать</button></div><div id="kout"></div></div>
  <div class="bar"><input id="q" placeholder="Поиск по ключу  ( / )" autocomplete="off"><select id="fp">${opts(titles, 'Все товары')}</select><select id="fs"><option value="">Все</option><option value="free">Свободные</option><option value="used">Использованные</option></select><button class="g s" id="ex">CSV</button><button class="g s" id="rf">↻</button></div>
  <div class="bar" id="selbar"></div><div id="t"></div>`;
  let keys = [], cur = [];
  const selBar = () => {
    $('#selbar').innerHTML = sel.size ? `<span class="mut">Выбрано: ${sel.size}</span><button class="g s" id="sc">Копировать</button><button class="d s" id="sd">Удалить</button><button class="g s" id="sx">Снять выбор</button>` : '';
    const sa = $('#sa'); if (sa) { const fr = cur.filter(k => !k.used_by); sa.checked = !!fr.length && fr.every(k => sel.has(k.key)); }
  };
  const g = grid($('#t'), [
    { h: '<input type="checkbox" id="sa" title="Выбрать все свободные в фильтре">', v: k => k.used_by ? '' : `<input type="checkbox" data-sel="${esc(k.key)}" ${sel.has(k.key) ? 'checked' : ''}>` },
    { h: 'Ключ', v: k => `<code>${esc(k.key)}</code> <button class="g s" data-c="${esc(k.key)}" title="Копировать">⧉</button>` },
    { h: 'Товар', v: k => esc(k.product_title), s: k => String(k.product_title).toLowerCase() },
    { h: 'Создан', v: k => fmt(k.created_at), s: k => String(k.created_at) },
    { h: 'Использован', v: k => k.used_by ? 'user #' + esc(k.used_by) + ' · ' + fmt(k.used_at) : '<span class="tag ok">свободен</span>', s: k => k.used_by ? 1 : 0 },
    { h: '', v: k => k.used_by ? '' : `<button class="s d" data-k="${esc(k.key)}">Удалить</button>` }
  ], { sort: 3, dir: -1, after: l => { cur = l; $('#cnt').textContent = `${l.length} из ${keys.length} · свободно ${keys.filter(k => !k.used_by).length}`; selBar(); } });
  const draw = keep => {
    const q = $('#q').value.trim().toLowerCase(), p = $('#fp').value, s = $('#fs').value;
    g.set(keys.filter(k => (!q || String(k.key).toLowerCase().includes(q)) && (!p || k.product_title === p) && (!s || (s === 'used') === !!k.used_by)), keep);
  };
  const load = async () => {
    const r = await act(() => api('/api/admin/keys')); if (!r || n !== navId) return;
    keys = r.data; const have = new Set(keys.filter(k => !k.used_by).map(k => k.key)); [...sel].forEach(k => have.has(k) || sel.delete(k)); draw(true);
  };
  refreshKeys = load;
  const showNew = () => {
    $('#kout').innerHTML = lastKeys.length ? `<div class="mono">${lastKeys.map(esc).join('<br>')}</div><div class="row" style="margin-top:8px"><button class="g s" id="nc">Копировать все</button><button class="g s" id="nd">Скачать .txt</button></div>` : '';
    if (lastKeys.length) { $('#nc').onclick = () => copy(lastKeys.join('\n'), 'Ключи скопированы'); $('#nd').onclick = () => saveFile('keys.txt', lastKeys.join('\n')); }
  };
  $('#q').oninput = debounce(() => draw()); $('#fp').onchange = $('#fs').onchange = () => draw();
  $('#rf').onclick = load;
  $('#ex').onclick = () => exportCsv('keys', ['Ключ', 'Товар', 'Создан', 'Использован кем', 'Когда'], cur.map(k => [k.key, k.product_title, k.created_at, k.used_by ?? '', k.used_at ?? '']));
  $('#t').addEventListener('click', async e => {
    const c = e.target.closest('[data-c]'); if (c) return copy(c.dataset.c, 'Ключ скопирован');
    const del = e.target.closest('[data-k]');
    if (del && confirm('Удалить ключ ' + del.dataset.k + '?')) { if (await act(() => api('/api/admin/keys/delete', 'POST', { key: del.dataset.k }), 'Удалён', del)) { sel.delete(del.dataset.k); load(); } }
  });
  $('#t').addEventListener('change', e => {
    const t = e.target;
    if (t.dataset.sel) { t.checked ? sel.add(t.dataset.sel) : sel.delete(t.dataset.sel); selBar(); }
    if (t.id === 'sa') { cur.filter(k => !k.used_by).forEach(k => t.checked ? sel.add(k.key) : sel.delete(k.key)); draw(true); }
  });
  $('#selbar').addEventListener('click', async e => {
    const id = e.target.id;
    if (id === 'sx') { sel.clear(); draw(true); }
    if (id === 'sc') copy([...sel].join('\n'), `Скопировано ключей: ${sel.size}`);
    if (id === 'sd' && confirm(`Удалить выбранные ключи (${sel.size})? Это необратимо.`)) {
      e.target.disabled = true; let ok = 0;
      for (const key of [...sel]) {
        try { await api('/api/admin/keys/delete', 'POST', { key }); sel.delete(key); ok++; }
        catch (er) { toast(`${key}: ${er.message}`, true); break; }
      }
      toast(`Удалено: ${ok}`); load();
    }
  });
  $('#kg').onclick = async e => {
    const cnt = +$('#kn').value, pid = $('#kp').value;
    if (!pid) return toast('Выберите товар', true);
    if (!Number.isInteger(cnt) || cnt < 1 || cnt > 100) return toast('Количество: от 1 до 100', true);
    const j = await act(() => api('/api/admin/keys', 'POST', { productId: pid, count: cnt }), null, e.target);
    if (j) { lastKeys = j.keys; showNew(); toast(`Создано ключей: ${j.keys.length}`); load(); }
  };
  showNew(); await load();
}

// ---------- покупки
async function purchases() {
  const n = navId, r = await act(() => api('/api/admin/purchases')); if (!r || n !== navId) return;
  const all = r.data, srcs = [...new Set(all.map(p => p.source))].filter(Boolean).sort();
  $('#m').innerHTML = `<div class="head"><h2>Последние покупки</h2><button class="g s" id="ex">CSV</button></div><div class="bar"><input id="q" placeholder="Поиск: пользователь, товар  ( / )" autocomplete="off"><select id="fs">${opts(srcs, 'Все источники')}</select></div><p class="mut sum" id="sum"></p><div id="t"></div>`;
  let cur = [];
  const now = Date.now();
  const g = grid($('#t'), [
    { h: 'ID', v: p => p.id, s: p => +p.id },
    { h: 'Пользователь', v: p => esc(p.username), s: p => String(p.username).toLowerCase() },
    { h: 'Товар', v: p => esc(p.title), s: p => String(p.title).toLowerCase() },
    { h: 'Цена', v: p => money(p.price), s: p => +p.price },
    { h: 'Источник', v: p => esc(p.source), s: p => String(p.source) },
    { h: 'Дата', v: p => fmt(p.purchased_at), s: p => String(p.purchased_at) },
    { h: 'Истекает', v: p => p.expires_at ? fmt(p.expires_at) + (new Date(p.expires_at) < now ? ' <span class="tag ban">истёк</span>' : '') : '—', s: p => String(p.expires_at ?? '') }
  ], { sort: 0, dir: -1, after: l => { cur = l; $('#sum').textContent = `Найдено: ${l.length} · сумма: ${money(l.reduce((s, p) => s + (+p.price || 0), 0))}`; } });
  const draw = () => { const q = $('#q').value.trim().toLowerCase(), s = $('#fs').value; g.set(all.filter(p => (!q || [p.username, p.title].join(' ').toLowerCase().includes(q)) && (!s || p.source === s))); };
  $('#q').oninput = debounce(draw); $('#fs').onchange = draw;
  $('#ex').onclick = () => exportCsv('purchases', ['ID', 'Пользователь', 'Товар', 'Цена', 'Источник', 'Дата', 'Истекает'], cur.map(p => [+p.id, p.username, p.title, +p.price, p.source, p.purchased_at, p.expires_at ?? '']));
  draw();
}

// ---------- журнал
async function audit() {
  const n = navId, r = await act(() => api('/api/admin/audit')); if (!r || n !== navId) return;
  const all = r.data, acts = [...new Set(all.map(a => a.action))].filter(Boolean).sort(), adm = [...new Set(all.map(a => a.admin_name))].filter(Boolean).sort();
  $('#m').innerHTML = `<div class="head"><h2>Журнал действий админов <span class="mut" id="cnt"></span></h2><button class="g s" id="ex">CSV</button></div><div class="bar"><input id="q" placeholder="Поиск по деталям  ( / )" autocomplete="off"><select id="fa">${opts(acts, 'Все действия')}</select><select id="fm">${opts(adm, 'Все админы')}</select></div><div id="t"></div>`;
  let cur = [];
  const g = grid($('#t'), [
    { h: 'Время', v: a => fmt(a.ts), s: a => String(a.ts) },
    { h: 'Админ', v: a => esc(a.admin_name), s: a => String(a.admin_name).toLowerCase() },
    { h: 'Действие', v: a => esc(a.action), s: a => String(a.action) },
    { h: 'Детали', v: a => esc(a.detail), c: 'wrap' }
  ], { sort: 0, dir: -1, size: 50, after: l => { cur = l; $('#cnt').textContent = `${l.length} из ${all.length}`; } });
  const draw = () => { const q = $('#q').value.trim().toLowerCase(), x = $('#fa').value, m = $('#fm').value; g.set(all.filter(a => (!q || String(a.detail ?? '').toLowerCase().includes(q)) && (!x || a.action === x) && (!m || a.admin_name === m))); };
  $('#q').oninput = debounce(draw); $('#fa').onchange = $('#fm').onchange = draw;
  $('#ex').onclick = () => exportCsv('audit', ['Время', 'Админ', 'Действие', 'Детали'], cur.map(a => [a.ts, a.admin_name, a.action, a.detail ?? '']));
  draw();
}

// ---------- безопасность
function sec() {
  const t0 = +ss.get(T0) || Date.now(), end = new Date(t0 + SESSION_MS);
  $('#m').innerHTML = `<h2>Безопасность</h2>
  <div class="box stack" style="max-width:420px;margin-bottom:14px"><b>Сессия</b><p class="mut">Вход: ${fmt(new Date(t0 - new Date().getTimezoneOffset() * 6e4).toISOString())} · автовыход: ${fmt(new Date(end - new Date().getTimezoneOffset() * 6e4).toISOString())}<br>Также выход через 15 минут бездействия. Токен хранится только в этой вкладке.</p><button class="g" id="all">Завершить все мои сессии</button></div>
  <form class="box stack" id="f" style="max-width:420px"><b>2FA включена ✓</b><p class="mut">Чтобы отключить 2FA — пароль и текущий код.</p><input name="p" type="password" placeholder="Пароль" autocomplete="current-password" required><input name="c" inputmode="numeric" placeholder="Код 2FA" autocomplete="off" required><button class="d" id="go">Отключить 2FA</button></form>`;
  $('#all').onclick = async e => { if (confirm('Завершить все ваши сессии на всех устройствах?') && await act(() => api('/api/admin/users/logout', 'POST', { userId: me.id }), null, e.target)) forget('Сессии завершены'); };
  $('#f').onsubmit = async e => {
    e.preventDefault();
    if (!confirm('Отключить 2FA? Админка закроется, пока не включите снова.')) return;
    if (await act(() => api('/api/admin/2fa/disable', 'POST', { password: e.target.p.value, code: e.target.c.value.trim() }), '2FA отключена', $('#go'))) boot();
  };
}

async function boot() {
  if (!tok) return loginScreen();
  try { me = (await api('/api/auth/me')).user; } catch { ss.del(TK); ss.del(T0); tok = null; return loginScreen(); }
  if (me.role !== 'admin') { view('<div class="center"><div class="box"><h1>Нет доступа</h1><p class="mut">Этот аккаунт не админ.</p><button id="out">Выйти</button></div></div>'); return $('#out').onclick = () => logout(); }
  const s = await act(() => api('/api/admin/2fa/status')); if (!s) return;
  if (!s.enabled) return setupScreen();
  if (!s.verified) return codeScreen();
  panel();
}
boot();