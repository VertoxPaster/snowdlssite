/* ============================================================
   SNOWCLIENT — MAIN SCRIPT  v6.1  (clean dark · auth · motion)
   ============================================================ */

'use strict';

let currentLang = localStorage.getItem('snow_lang') || CONFIG.defaultLanguage;
const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const TOUCH   = window.matchMedia('(hover: none)').matches;

/* ════════════════════════════════════════
   INIT    
════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  applyColors();
  splitTitle();
  setupMarquee();
  buildLangDropdown();
  setLanguage(currentLang);
  buildScreenshots();
  populateContact();
  setupNavScroll();
  setupReveal();
  setupCursorGlow();
  setupSmoothLinks();
  setupSpotlight();
  setupTilt();
  setupMagnetic();
  setupCardTilt();
  prefillReferral();
  loadSession();
  handleAuthQuery();

  if (CONFIG.video.url) embedVideo(CONFIG.video.url);

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeAllModals();
  });
});

function handleAuthQuery() {
  try {
    const params = new URLSearchParams(location.search);
    const mode = params.get('auth');
    if (mode === 'login' || mode === 'register') {
      if (params.get('next') === 'cabinet') {
        sessionStorage.setItem('auth_next', '/cabinet');
      }
      openAuth(mode);
      params.delete('auth');
      params.delete('next');
      const clean = params.toString();
      history.replaceState(null, '', location.pathname + (clean ? '?' + clean : '') + location.hash);
    }
  } catch {}
}

/* ════════════════════════════════════════
   COLORS → CSS Variables
════════════════════════════════════════ */
function applyColors() {
  const c = CONFIG.colors;
  const s = document.documentElement.style;
  s.setProperty('--primary',       c.primary);
  s.setProperty('--primary-light', c.primaryLight);
  s.setProperty('--primary-dark',  c.primaryDark);
  s.setProperty('--secondary',     c.secondary);
  if (c.accent) s.setProperty('--accent', c.accent);
  s.setProperty('--bg',            c.bg);
  s.setProperty('--bg-card',       c.bgCard);
  s.setProperty('--bg-card-hover', c.bgCardHover);
  s.setProperty('--text',          c.text);
  s.setProperty('--text-muted',    c.textMuted);
  s.setProperty('--border',        c.border);
  s.setProperty('--success',       c.success);
  s.setProperty('--glow',          c.glow);
}

/* ════════════════════════════════════════
   HERO TITLE — разбивка на буквы
════════════════════════════════════════ */
function splitTitle() {
  let idx = 0;
  document.querySelectorAll('[data-split]').forEach(el => {
    const text = el.getAttribute('data-split');
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = [...text].map(ch =>
      `<span class="char" style="--i:${idx++}">${ch}</span>`
    ).join('');
  });
}

/* ════════════════════════════════════════
   MARQUEE — дублируем содержимое для бесшовной ленты
════════════════════════════════════════ */
function setupMarquee() {
  const track = document.getElementById('marqueeTrack');
  if (track) track.innerHTML += track.innerHTML;
}

/* ════════════════════════════════════════
   CURSOR GLOW
════════════════════════════════════════ */
function setupCursorGlow() {
  const glow = document.getElementById('cursorGlow');
  if (!glow || TOUCH || REDUCED) {
    if (glow) glow.style.display = 'none';
    return;
  }

  let mx = -9999, my = -9999;
  let cx = -9999, cy = -9999;

  document.addEventListener('mousemove', e => { mx = e.clientX; my = e.clientY; });

  (function tick() {
    cx += (mx - cx) * 0.08;
    cy += (my - cy) * 0.08;
    glow.style.left = cx + 'px';
    glow.style.top  = cy + 'px';
    requestAnimationFrame(tick);
  })();
}

/* ════════════════════════════════════════
   SPOTLIGHT — подсветка карточек за курсором
════════════════════════════════════════ */
function setupSpotlight() {
  if (TOUCH) return;
  document.addEventListener('mousemove', e => {
    const card = e.target.closest?.('.spot');
    if (!card) return;
    const r = card.getBoundingClientRect();
    card.style.setProperty('--mx', (e.clientX - r.left) + 'px');
    card.style.setProperty('--my', (e.clientY - r.top)  + 'px');
  }, { passive: true });
}

/* ════════════════════════════════════════
   TILT — 3D-наклон видео за курсором
════════════════════════════════════════ */
function setupTilt() {
  if (TOUCH || REDUCED) return;
  document.querySelectorAll('.tilt').forEach(el => {
    const host = el.closest('.hero-right') || el;
    host.addEventListener('mousemove', e => {
      const r = el.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width  - 0.5;
      const py = (e.clientY - r.top)  / r.height - 0.5;
      el.style.transform =
        `rotateX(${(-py * 9).toFixed(2)}deg) rotateY(${(px * 11).toFixed(2)}deg) scale(1.02)`;
    });
    host.addEventListener('mouseleave', () => {
      el.style.transform = '';
    });
  });
}

/* ════════════════════════════════════════
   MAGNETIC BUTTONS
════════════════════════════════════════ */
function setupMagnetic() {
  if (TOUCH || REDUCED) return;
  document.querySelectorAll('.magnetic').forEach(btn => {
    btn.addEventListener('mousemove', e => {
      const r = btn.getBoundingClientRect();
      const x = (e.clientX - (r.left + r.width / 2))  * 0.25;
      const y = (e.clientY - (r.top  + r.height / 2)) * 0.35;
      btn.style.transform = `translate(${x}px, ${y}px)`;
    });
    btn.addEventListener('mouseleave', () => { btn.style.transform = ''; });
  });
}

/* ════════════════════════════════════════
   NAVBAR + SCROLL PROGRESS
════════════════════════════════════════ */
function setupNavScroll() {
  const nav = document.getElementById('navbar');
  const bar = document.getElementById('scrollProgress');
  let ticking = false;

  const update = () => {
    nav.classList.toggle('scrolled', window.scrollY > 36);
    if (bar) {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      bar.style.transform = `scaleX(${max > 0 ? Math.min(window.scrollY / max, 1) : 0})`;
    }
    ticking = false;
  };
  window.addEventListener('scroll', () => {
    if (!ticking) { requestAnimationFrame(update); ticking = true; }
  }, { passive: true });
  update();
}

/* ════════════════════════════════════════
   SMOOTH SCROLL LINKS
════════════════════════════════════════ */
function setupSmoothLinks() {
  document.querySelectorAll('a[href^="#"]').forEach(a => {
    a.addEventListener('click', e => {
      const href = a.getAttribute('href');
      if (href === '#') return;
      const target = document.querySelector(href);
      if (target) {
        e.preventDefault();
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });
}

/* ════════════════════════════════════════
   REVEAL ON SCROLL
════════════════════════════════════════ */
let revealObs = null;

function setupReveal() {
  revealObs = new IntersectionObserver(entries => {
    // каскад: элементы, появившиеся одним пакетом, выезжают по очереди
    const vis = entries
      .filter(e => e.isIntersecting)
      .sort((x, y) => (x.boundingClientRect.top - y.boundingClientRect.top) || (x.boundingClientRect.left - y.boundingClientRect.left));

    vis.forEach((entry, i) => {
      const el = entry.target;
      const delay = REDUCED ? 0 : Math.min(i, 8) * 90;
      el.style.setProperty('--st', delay + 'ms');
      el.classList.add('visible');
      revealObs.unobserve(el);

      // после окончания появления убираем задержку, чтобы hover был быстрым
      setTimeout(() => el.classList.add('settled'), 1300 + delay);

      // анимация счётчика цены
      el.querySelectorAll('[data-count]').forEach(countUp);
    });
  }, { threshold: 0.07, rootMargin: '0px 0px -20px 0px' });

  observeRevealElements();
}

function observeRevealElements() {
  document.querySelectorAll('.reveal:not(.visible)').forEach(el => revealObs?.observe(el));
}

function countUp(el) {
  const target = parseFloat(el.getAttribute('data-count'));
  if (isNaN(target)) return;
  const isInt = Number.isInteger(target);
  if (REDUCED) { el.textContent = isInt ? String(target) : target.toFixed(2); return; }

  const dur = 1200;
  const t0 = performance.now();
  (function step(now) {
    const p = Math.min((now - t0) / dur, 1);
    const eased = 1 - Math.pow(1 - p, 4);
    const val = target * eased;
    el.textContent = isInt ? Math.round(val) : val.toFixed(2);
    if (p < 1) requestAnimationFrame(step);
  })(t0);
}

/* ════════════════════════════════════════
   LANGUAGE SYSTEM
════════════════════════════════════════ */
function buildLangDropdown() {
  const dropdown = document.getElementById('langDropdown');
  dropdown.innerHTML = CONFIG.languages.map(l => `
    <div class="lang-option ${l.code === currentLang ? 'active' : ''}" onclick="setLanguage('${l.code}')">
      <span class="lang-flag">${l.flag}</span>
      <span>${l.full}</span>
      <span class="lang-code-badge">${l.label}</span>
    </div>
  `).join('');
}

function toggleLangDropdown() {
  document.getElementById('langBtn').classList.toggle('open');
  document.getElementById('langDropdown').classList.toggle('open');
}

document.addEventListener('click', e => {
  const sel = document.getElementById('langSelector');
  if (sel && !sel.contains(e.target)) closeLangDropdown();
});

function closeLangDropdown() {
  document.getElementById('langBtn')?.classList.remove('open');
  document.getElementById('langDropdown')?.classList.remove('open');
}

function setLanguage(lang) {
  currentLang = lang;
  try { localStorage.setItem('snow_lang', lang); } catch {}

  const t     = CONFIG.i18n[lang];
  const nav   = CONFIG.nav.links[lang];
  const found = CONFIG.languages.find(l => l.code === lang);

  document.getElementById('langLabel').textContent = found?.label ?? lang.toUpperCase();
  document.getElementById('langFlag').textContent  = found?.flag  ?? '';

  document.querySelectorAll('.lang-option').forEach((el, i) => {
    el.classList.toggle('active', CONFIG.languages[i]?.code === lang);
  });

  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    if (/^nav\d+$/.test(key)) {
      const idx = parseInt(key.slice(3));
      if (nav[idx] !== undefined) el.textContent = nav[idx];
    } else if (t[key] !== undefined) {
      el.textContent = t[key];
    }
  });

  document.querySelectorAll('[data-mob-i18n]').forEach(el => {
    const key = el.getAttribute('data-mob-i18n');
    if (/^nav\d+$/.test(key)) {
      const idx = parseInt(key.slice(3));
      if (nav[idx] !== undefined) el.textContent = nav[idx];
    }
  });

  const taglineEl = document.getElementById('heroTagline');
  const quoteEl   = document.getElementById('heroQuote');
  const hintEl    = document.getElementById('heroVideoHint');
  if (taglineEl) taglineEl.textContent = CONFIG.clientTagline[lang] ?? CONFIG.clientTagline.ru;
  if (quoteEl)   quoteEl.textContent   = CONFIG.heroQuote[lang]     ?? CONFIG.heroQuote.ru;
  if (hintEl)    hintEl.textContent    = CONFIG.video.placeholder[lang] ?? CONFIG.video.placeholder.ru;

  const heroBtnBuy = document.getElementById('heroBtnBuy');
  if (heroBtnBuy) heroBtnBuy.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
      <path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z"/>
      <line x1="3" y1="6" x2="21" y2="6"/>
      <path d="M16 10a4 4 0 01-8 0"/>
    </svg>
    ${t.buyNowHero}
  `;
  const heroBtnLearn = document.getElementById('heroBtnLearn');
  if (heroBtnLearn) heroBtnLearn.textContent = t.learnMore;

  const footerTagline = document.getElementById('footerTagline');
  const footerCopy    = document.getElementById('footerCopy');
  if (footerTagline) footerTagline.textContent = CONFIG.clientTagline[lang] ?? CONFIG.clientTagline.ru;
  if (footerCopy)    footerCopy.textContent    = t.footerCopy;

  const vpt = document.getElementById('videoPlaceholderText');
  if (vpt) vpt.textContent = CONFIG.video.placeholder[lang] ?? CONFIG.video.placeholder.ru;

  document.documentElement.lang = lang;

  closeLangDropdown();

  buildFeatures();
  buildPricing();
  updateAuthTexts();
  renderAuthUI();
  if (isModalOpen('cabinet')) renderCabinet();
}

/* ════════════════════════════════════════
   FEATURES
════════════════════════════════════════ */
const FEATURE_ICONS = [
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="3"/>
    <path d="M3 9h18M9 21V9"/>
  </svg>`,
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 20h9M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/>
  </svg>`,
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="22,12 18,12 15,21 9,3 6,12 2,12"/>
  </svg>`,
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="23,4 23,10 17,10"/>
    <path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/>
  </svg>`,
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
    <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
  </svg>`,
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
    <polyline points="9,12 11,14 15,10"/>
  </svg>`
];

function buildFeatures() {
  const grid  = document.getElementById('featuresGrid');
  const items = CONFIG.features[currentLang] ?? CONFIG.features.ru;

  grid.innerHTML = items.map((f, i) => `
    <div class="feature-card spot reveal reveal-d${(i % 6) + 1}">
      <span class="feature-num">${String(i + 1).padStart(2, '0')}</span>
      <div class="feature-icon-wrap">
        ${FEATURE_ICONS[i] ?? FEATURE_ICONS[0]}
      </div>
      <div class="feature-title">${f.title}</div>
      <div class="feature-desc">${f.desc}</div>
    </div>
  `).join('');

  observeRevealElements();
}

/* ════════════════════════════════════════
   SCREENSHOTS
════════════════════════════════════════ */
function buildScreenshots() {
  const grid  = document.getElementById('screenshotsGrid');
  const shots = CONFIG.screenshots;

  grid.innerHTML = shots.map((s, i) => `
    <div class="screenshot-item ${i === 0 ? 'screenshot-main' : ''} reveal reveal-d${i + 1}">
      <img
        src="${s.url}"
        alt="${s.alt}"
        loading="lazy"
        onerror="this.closest('.screenshot-item').style.display='none'"
      />
    </div>
  `).join('');

  observeRevealElements();
}

/* ════════════════════════════════════════
   PRICING
════════════════════════════════════════ */
function buildPricing() {
  const grid  = document.getElementById('pricingGrid');
  const t     = CONFIG.i18n[currentLang];
  const cur   = CONFIG.pricing.currency;
  const badge = CONFIG.pricing.badge[currentLang] ?? CONFIG.pricing.badge.ru;

  grid.innerHTML = CONFIG.pricing.plans.map((plan, i) => {
    const dur   = plan.duration[currentLang] ?? plan.duration.ru;
    const feats = plan.features[currentLang] ?? plan.features.ru;
    const isInt = Number.isInteger(plan.price);
    const priceStr = isInt ? String(plan.price) : plan.price.toFixed(2);
    const priceHtml = cur === '₽'
      ? `<span data-count="${plan.price}">${priceStr}</span><span class="currency" style="margin-left:4px;">${cur}</span>`
      : `<span class="currency">${cur}</span><span data-count="${plan.price}">${priceStr}</span>`;

    return `
      <div class="pricing-card spot ${plan.popular ? 'popular' : ''} reveal reveal-d${i + 1}">
        ${plan.popular ? `<div class="pricing-badge">${badge}</div>` : ''}
        <div class="pricing-duration">${dur}</div>
        <div class="pricing-price">
          ${priceHtml}
        </div>
        <div class="pricing-period">${t.perPeriod}</div>
        <ul class="pricing-features">
          ${feats.map(f => `
            <li>
              <span class="check">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                  <polyline points="20,6 9,17 4,12"/>
                </svg>
              </span>
              ${f}
            </li>
          `).join('')}
        </ul>
        <button
          class="btn ${plan.popular ? 'btn-primary' : 'btn-outline'}"
          style="width:100%;"
          onclick="handleBuy('${plan.id}', '${dur}', '${priceStr} ${cur}')"
        >
          ${t.btnBuy}
        </button>
      </div>
    `;
  }).join('');

  observeRevealElements();
}

/* ════════════════════════════════════════
   ПОКУПКА — логика из config.js → payment
════════════════════════════════════════ */
function handleBuy(planId, duration, price) {
  const pay = CONFIG.payment;
  if (pay.useRedirect) {
    const url = pay.redirectUrls?.[planId] || pay.funpayUrl || 'https://funpay.com/lots/offer?id=78533148';
    window.open(url, '_blank', 'noopener');
    return;
  }
  if (pay.usePopup) {
    showPaymentPopup(planId, duration, price);
    return;
  }
  // Своя логика (Stripe, LiqPay и т.д.) — сюда
  showToast(`${duration} — ${price}`, 'success');
}

function showPaymentPopup(planId, duration, price) {
  const t = CONFIG.i18n[currentLang];
  const link = CONFIG.payment.popupContact;

  const overlay = document.getElementById('modalPayment');
  const title   = document.getElementById('paymentPopupTitle');
  const body    = document.getElementById('paymentPopupBody');
  const linkEl  = document.getElementById('paymentPopupLink');

  if (!overlay) return;

  if (title)  title.textContent = `${t.paymentPopupTitle} — ${duration} (${price})`;
  if (body)   body.textContent  = t.paymentPopupText;
  if (linkEl) linkEl.href = link;

  overlay.classList.add('open');
  document.body.style.overflow = 'hidden';
}

/* ════════════════════════════════════════
   VIDEO EMBED (только через config.js)
════════════════════════════════════════ */
function embedVideo(url) {
  const videoId = extractYouTubeId(url);
  if (!videoId) return;

  const src = `https://www.youtube.com/embed/${videoId}?rel=0&modestbranding=1&color=white`;
  const iframe = `<iframe
    src="${src}"
    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
    allowfullscreen
    loading="lazy"
    title="SnowClient — Gameplay"
  ></iframe>`;

  const heroFrame    = document.getElementById('heroVideoFrame');
  const sectionEmbed = document.getElementById('videoContainer');
  if (heroFrame)    heroFrame.innerHTML    = iframe;
  if (sectionEmbed) sectionEmbed.innerHTML = iframe;
}

function extractYouTubeId(url) {
  if (!url) return null;
  const patterns = [
    /[?&]v=([a-zA-Z0-9_-]{11})/,
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /embed\/([a-zA-Z0-9_-]{11})/,
    /shorts\/([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/
  ];
  for (const re of patterns) {
    const m = url.match(re);
    if (m) return m[1];
  }
  return null;
}

/* ════════════════════════════════════════
   CONTACTS
════════════════════════════════════════ */
function populateContact() {
  const { email, hours, discord, telegram } = CONFIG.contact;

  const emailCard = document.getElementById('supportEmailCard');
  if (emailCard) emailCard.href = `mailto:${email}`;

  const emailVal = document.getElementById('supportEmailVal');
  if (emailVal) emailVal.textContent = email;

  const hoursVal = document.getElementById('supportHoursVal');
  if (hoursVal) hoursVal.textContent = hours;

  const discordCard = document.getElementById('supportDiscordCard');
  if (discordCard) discordCard.href = discord;

  const tgCard = document.getElementById('supportTelegramCard');
  if (tgCard) tgCard.href = telegram;

  const footerDiscord  = document.getElementById('footerDiscord');
  const footerTelegram = document.getElementById('footerTelegram');
  if (footerDiscord)  footerDiscord.href  = discord;
  if (footerTelegram) footerTelegram.href = telegram;
}

/* ════════════════════════════════════════
   MOBILE MENU
════════════════════════════════════════ */
function toggleMobileMenu() {
  document.getElementById('mobileMenu').classList.toggle('open');
  document.getElementById('hamburger').classList.toggle('open');
}
function closeMobileMenu() {
  document.getElementById('mobileMenu').classList.remove('open');
  document.getElementById('hamburger').classList.remove('open');
}

/* ════════════════════════════════════════
   MODALS
════════════════════════════════════════ */
const MODAL_IDS = {
  privacy: 'modalPrivacy',
  terms:   'modalTerms',
  rules:   'modalRules',
  payment: 'modalPayment',
  auth:    'modalAuth',
  cabinet: 'modalCabinet'
};

let returnToAuth = false;   // открыли соглашение из формы регистрации → после закрытия вернуть форму

function openModal(key) {
  closeAllModals();
  const id = MODAL_IDS[key];
  if (!id) return;
  document.getElementById(id)?.classList.add('open');
  document.body.style.overflow = 'hidden';
}

function isModalOpen(key) {
  return !!document.getElementById(MODAL_IDS[key])?.classList.contains('open');
}

function closeModal(key) {
  const id = MODAL_IDS[key];
  if (!id) return;
  document.getElementById(id)?.classList.remove('open');
  document.body.style.overflow = '';
  if (key === 'terms' && returnToAuth) {
    returnToAuth = false;
    openModal('auth');
  }
}

function openTermsFromAuth(e) {
  if (e) e.preventDefault();
  openModal('terms');
  returnToAuth = true;
}

function closeAllModals() {
  returnToAuth = false;
  Object.values(MODAL_IDS).forEach(id => {
    document.getElementById(id)?.classList.remove('open');
  });
  document.body.style.overflow = '';
}

function closeModalOutside(event, modalId) {
  if (event.target.id !== modalId) return;
  if (modalId === 'modalTerms') return closeModal('terms');
  document.getElementById(modalId)?.classList.remove('open');
  document.body.style.overflow = '';
}


/* ════════════════════════════════════════
   CARD TILT — 3D-наклон + магнитное притяжение карточек
════════════════════════════════════════ */
function setupCardTilt() {
  if (TOUCH || REDUCED) return;
  const SEL = '.feature-card, .pricing-card';
  let active = null;

  document.addEventListener('mousemove', e => {
    const card = e.target.closest?.(SEL);
    if (active && active !== card) resetTilt(active);
    if (!card || !card.classList.contains('visible')) return;
    active = card;
    const r = card.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width  - 0.5;
    const py = (e.clientY - r.top)  / r.height - 0.5;
    card.classList.add('tilting');
    card.style.setProperty('--tilt',
      `perspective(900px) translate3d(${(px * 6).toFixed(1)}px, ${(py * 6 - 6).toFixed(1)}px, 0) rotateX(${(-py * 7).toFixed(2)}deg) rotateY(${(px * 9).toFixed(2)}deg)`);
  }, { passive: true });

  document.addEventListener('mouseleave', () => active && resetTilt(active));

  function resetTilt(el) {
    el.classList.remove('tilting');
    el.style.removeProperty('--tilt');
    if (active === el) active = null;
  }
}

/* ════════════════════════════════════════
   AUTH — интеграция с server.py
════════════════════════════════════════ */
const TOKEN_KEY = CONFIG.auth?.tokenKey || 'vortex_token';
const CUR       = CONFIG.auth?.balanceCurrency || '₽';

let currentUser = null;
let userBalance = null;
let authTab     = 'login';
let authBusy    = false;

const tt  = key => (CONFIG.i18n[currentLang] && CONFIG.i18n[currentLang][key]) ?? CONFIG.i18n.ru[key] ?? key;
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const fmtMoney = n => (Number(n) || 0).toFixed(2) + ' ' + CUR;

function getToken() { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } }
function setToken(t) { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch {} }

/* Универсальный запрос к API */
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

/* ── Сессия ── */
async function loadSession() {
  const token = getToken();
  if (!token) { renderAuthUI(); return; }
  try {
    const r = await api('/api/auth/me');
    currentUser = r.data || r.user || null;
    renderAuthUI();
    refreshBalance();
  } catch (e) {
    if (e.status === 401) setToken(null);   // токен протух — чистим
    currentUser = null;
    renderAuthUI();
  }
}

async function refreshBalance() {
  if (!currentUser) return;
  try {
    const r = await api('/api/balance');
    userBalance = Number((r.data && r.data.balance) ?? r.balance ?? 0);
    renderAuthUI();
    if (isModalOpen('cabinet')) renderCabinetBalance();
  } catch (e) {
    if (e.status === 401) handleExpired();
  }
}

function handleExpired() {
  setToken(null); currentUser = null; userBalance = null;
  renderAuthUI();
  closeModal('cabinet');
}

/* ── Кнопка в шапке ── */
function renderAuthUI() {
  const btn   = document.getElementById('navAuth');
  const name  = document.getElementById('navAuthName');
  const bal   = document.getElementById('navAuthBal');
  const av    = document.getElementById('navAuthAvatar');
  const mob   = document.getElementById('mobileAuthLabel');
  if (!btn) return;

  if (currentUser) {
    const uname = currentUser.username || currentUser.display_name || '?';
    btn.classList.add('logged');
    name.removeAttribute('data-i18n');
    name.textContent = uname;
    av.textContent = uname.charAt(0);
    if (currentUser.avatar && /^\/uploads\/local\/[\w.-]+$/.test(String(currentUser.avatar))) {
      const img = document.createElement('img');
      img.alt = '';
      img.addEventListener('error', () => { av.textContent = uname.charAt(0); });
      img.src = currentUser.avatar;
      av.textContent = '';
      av.append(img);
    }
    bal.hidden = userBalance === null;
    if (userBalance !== null) bal.textContent = fmtMoney(userBalance);
    if (mob) { mob.removeAttribute('data-i18n'); mob.textContent = `${uname}${userBalance !== null ? ' · ' + fmtMoney(userBalance) : ''}`; }
  } else {
    btn.classList.remove('logged');
    name.setAttribute('data-i18n', 'navLogin');
    name.textContent = tt('navLogin');
    av.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';
    bal.hidden = true;
    if (mob) { mob.setAttribute('data-i18n', 'navLogin'); mob.textContent = tt('navLogin'); }
  }
}

function onAuthClick() {
  if (currentUser) {
    location.href = '/cabinet';
  } else {
    openAuth('login');
  }
}

/* ── Модалка входа / регистрации ── */
function openAuth(tab = 'login') {
  openModal('auth');
  switchAuthTab(tab, true);
  clearAuthError();
  setTimeout(() => document.getElementById(authTab === 'register' ? 'authUsername' : 'authIdent')?.focus(), 350);
}

function switchAuthTab(tab, instant = false) {
  authTab = tab;
  const form = document.getElementById('authForm');
  const tabs = document.getElementById('authTabs');
  const reg  = tab === 'register';

  document.getElementById('tabLogin')?.classList.toggle('active', !reg);
  document.getElementById('tabRegister')?.classList.toggle('active', reg);
  tabs?.classList.toggle('is-register', reg);
  form?.classList.toggle('is-register', reg);

  if (!instant && form && !REDUCED) {
    form.classList.remove('switching'); void form.offsetWidth; form.classList.add('switching');
    setTimeout(() => form.classList.remove('switching'), 480);
  }
  updateAuthTexts();
  clearAuthError();
}

function updateAuthTexts() {
  const reg = authTab === 'register';
  const set = (id, key) => { const el = document.getElementById(id); if (el) el.textContent = tt(key); };
  set('authIdentLabel',    reg ? 'authEmail'        : 'authIdent');
  set('authPasswordLabel', reg ? 'authPasswordMin' : 'authPassword');
  set('authSubmitLabel',   reg ? 'authSubmitRegister' : 'authSubmitLogin');
  set('authSub',           reg ? 'authSubRegister' : 'authSubLogin');

  const ident = document.getElementById('authIdent');
  const pass  = document.getElementById('authPassword');
  if (ident) { ident.type = reg ? 'email' : 'text'; ident.autocomplete = reg ? 'email' : 'username'; }
  if (pass)  pass.autocomplete = reg ? 'new-password' : 'current-password';

  const key = document.getElementById('cabKeyInput');
  if (key) key.placeholder = tt('cabKeyPh');
}

function showAuthError(msg) {
  const el = document.getElementById('authError');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  const form = document.getElementById('authForm');
  if (form && !REDUCED) { form.classList.remove('shake'); void form.offsetWidth; form.classList.add('shake'); }
}
function clearAuthError() {
  const el = document.getElementById('authError');
  if (el) { el.classList.remove('show'); }
}

async function submitAuth(e) {
  e.preventDefault();
  if (authBusy) return;
  const reg   = authTab === 'register';
  const ident = document.getElementById('authIdent').value.trim();
  const pass  = document.getElementById('authPassword').value;
  const uname = document.getElementById('authUsername').value.trim();
  const ref   = document.getElementById('authReferral').value.trim();

  if (!ident || !pass || (reg && !uname)) return showAuthError(tt('authFill'));
  if (reg && (!/^[A-Za-z0-9_]{3,20}$/.test(uname) || pass.length < 6)) return showAuthError(tt('authShort'));
  if (reg && !document.getElementById('authAgree')?.checked) return showAuthError(tt('authAgreeNeed'));

  const submit = document.getElementById('authSubmit');
  authBusy = true; submit.classList.add('loading'); clearAuthError();

  try {
    const payload = reg
      ? { username: uname, email: ident, password: pass, acceptTerms: true, ...(ref ? { referralCode: ref } : {}) }
      : { email: ident, password: pass };                // email принимает и email, и ник
    const r = await api(reg ? '/api/auth/register' : '/api/auth/login', { method: 'POST', body: payload, token: null });

    const token = r.token || r.data?.token;
    const user  = r.user  || r.data?.user;
    if (!token) throw new Error('No token');

    setToken(token);
    currentUser = user || null;
    userBalance = user && typeof user.balance === 'number' ? user.balance : null;

    document.getElementById('authPassword').value = '';
    closeModal('auth');
    renderAuthUI();
    showToast((reg ? tt('authRegistered') : tt('authWelcome')) + (currentUser?.username || ''), 'success');
    refreshBalance();

    const nextUrl = sessionStorage.getItem('auth_next');
    if (nextUrl) {
      sessionStorage.removeItem('auth_next');
      location.href = nextUrl;
      return;
    }
  } catch (err) {
    showAuthError(err.message);
  } finally {
    authBusy = false; submit.classList.remove('loading');
  }
}

function prefillReferral() {
  try {
    const ref = new URLSearchParams(location.search).get('ref');
    if (ref) document.getElementById('authReferral').value = ref;
  } catch {}
}

/* ── Личный кабинет ── */
function roleLabel(role) {
  return ({ admin: tt('roleAdmin'), moderator: tt('roleModerator'), beta_tester: tt('roleBeta') })[role] || tt('roleUser');
}

function renderCabinetBalance() {
  const el = document.getElementById('cabBalance');
  if (el && userBalance !== null) el.textContent = fmtMoney(userBalance);
}

function renderCabinet() {
  const u = currentUser;
  if (!u) return;
  const uname = u.username || '?';
  const av = document.getElementById('cabAvatar');
  if (av) {
    if (u.avatar) { av.textContent = uname.charAt(0); if (/^\/uploads\/local\/[\w.-]+$/.test(String(u.avatar))) { const img = document.createElement('img'); img.alt = ''; img.addEventListener('error', () => { av.textContent = uname.charAt(0); }); img.src = u.avatar; av.textContent = ''; av.append(img); } }
    else av.textContent = uname.charAt(0);
  }
  document.getElementById('cabName').textContent  = u.display_name || uname;
  document.getElementById('cabEmail').textContent = u.email || '';
  const role = document.getElementById('cabRole');
  role.textContent = roleLabel(u.role);
  role.classList.toggle('admin', u.role === 'admin');
  document.getElementById('cabRef').textContent = u.ref_code || '—';
  document.getElementById('cabAdminBtn').hidden = u.role !== 'admin';
  document.getElementById('cabAdminBtn').href   = CONFIG.auth?.adminUrl || '/admin';
  renderCabinetBalance();
  if (userBalance === null) document.getElementById('cabBalance').textContent = '…';
}

async function openCabinet() {
  if (!currentUser) return openAuth('login');
  openModal('cabinet');
  renderCabinet();
  loadPurchases();
  refreshBalance();
  // подтягиваем свежий профиль (роль могла измениться)
  try {
    const r = await api('/api/auth/me');
    currentUser = r.data || r.user || currentUser;
    renderCabinet(); renderAuthUI();
  } catch (e) { if (e.status === 401) handleExpired(); }
}

function fmtDate(iso) {
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleDateString(currentLang === 'uk' ? 'uk-UA' : currentLang === 'en' ? 'en-GB' : currentLang, { day: '2-digit', month: 'short', year: 'numeric' });
}

async function loadPurchases() {
  const ul = document.getElementById('cabPurchases');
  if (!ul) return;
  try {
    const r = await api('/api/users/products');
    const list = r.data || [];
    if (!list.length) { ul.innerHTML = `<li class="cab-empty">${esc(tt('cabNoPurchases'))}</li>`; return; }
    ul.innerHTML = list.map((p, i) => `
      <li class="cab-purchase" style="--st:${Math.min(i, 8) * 70}ms">
        <div>
          <div class="cab-purchase-title">${esc(p.title || ('#' + p.product_id))}</div>
          <div class="cab-purchase-meta">${esc(fmtDate(p.purchased_at))}</div>
        </div>
        <span class="cab-purchase-badge">${p.expires_at ? esc(tt('cabUntil') + fmtDate(p.expires_at)) : esc(tt('cabForever'))}</span>
      </li>`).join('');
  } catch (e) {
    if (e.status === 401) return handleExpired();
    ul.innerHTML = `<li class="cab-empty">${esc(e.message)}</li>`;
  }
}

async function activateKey(e) {
  e.preventDefault();
  const input = document.getElementById('cabKeyInput');
  const btn   = document.getElementById('cabKeyBtn');
  const key   = input.value.trim();
  if (!key) return showToast(tt('cabKeyEmpty'), 'error');
  if (btn.classList.contains('loading')) return;

  btn.classList.add('loading');
  try {
    const r = await api('/api/keys/activate', { method: 'POST', body: { key } });
    const title = r.product?.title || r.data?.product?.title || '';
    input.value = '';
    showToast(tt('cabKeyOk') + title, 'success');
    loadPurchases();
  } catch (err) {
    if (err.status === 401) handleExpired();
    showToast(err.message, 'error');
  } finally {
    btn.classList.remove('loading');
  }
}

async function logout() {
  try { await api('/api/auth/logout', { method: 'POST', body: {} }); } catch {}
  setToken(null);
  currentUser = null; userBalance = null;
  closeModal('cabinet');
  renderAuthUI();
  showToast(tt('authLoggedOut'), 'info');
}

function copyRefCode() {
  const code = currentUser?.ref_code;
  if (!code) return;
  (navigator.clipboard?.writeText(code) || Promise.reject()).then(
    () => showToast(tt('cabCopied'), 'success'),
    () => {}
  );
}

/* ════════════════════════════════════════
   TOAST
════════════════════════════════════════ */
let toastTimer = null;

function showToast(msg, type = 'success') {
  const toast    = document.getElementById('toast');
  const toastMsg = document.getElementById('toastMsg');
  if (!toast || !toastMsg) return;

  toastMsg.textContent = msg;
  toast.className = `toast ${type} show`;

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3500);
}