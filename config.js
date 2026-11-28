// ============================================================
// КОНФИГУРАЦИЯ SNOWCLIENT (ZENITH DARK EDITION)
// ============================================================

const CONFIG = {
  clientName: "SnowClient",
  clientTagline: {
    ru: "Клиент для Minecraft 1.21.11 · Fabric",
    en: "Client for Minecraft 1.21.11 · Fabric",
    uk: "Клієнт для Minecraft 1.21.11 · Fabric",
    pl: "Klient dla Minecraft 1.21.11 · Fabric",
    tr: "Minecraft 1.21.11 · Fabric İstemcisi"
  },
  heroQuote: {
    ru: "Стабильный FPS, чистый интерфейс и гибкие настройки.",
    en: "Stable FPS, clean interface, and flexible settings.",
    uk: "Стабільний FPS, чистий інтерфейс та гнучкі налаштування.",
    pl: "Stabilny FPS, czysty interfejs i elastyczna konfiguracja.",
    tr: "Stabil FPS, sade arayüz ve esnek ayarlar."
  },

  colors: {
    primary:      "#E4E5E9",
    primaryLight: "#FFFFFF",
    primaryDark:  "#D0D2D8",
    secondary:    "#8E919B",
    accent:       "#C7C9D1",
    bg:           "#050507",
    bgCard:       "rgba(11, 12, 15, 0.62)",
    bgCardHover:  "rgba(18, 19, 24, 0.76)",
    text:         "#F2F3F5",
    textMuted:    "#8A8D96",
    border:       "rgba(255, 255, 255, 0.07)",
    success:      "#22C55E",
    glow:         "rgba(255, 255, 255, 0.08)"
  },

  nav: {
    links: {
      ru: ["Главная", "Функции", "Обзор", "Тарифы", "Поддержка"],
      en: ["Home",    "Features", "Review", "Pricing", "Support"],
      uk: ["Головна", "Функції",  "Огляд",  "Тарифи",  "Підтримка"],
      pl: ["Główna",  "Funkcje",  "Przegląd", "Cennik", "Wsparcie"],
      tr: ["Ana",     "Özellikler","İnceleme","Fiyatlar","Destek"]
    },
    anchors: ["#hero", "#features", "#video", "#pricing", "#support"]
  },

  contact: {
    email:    "snowclient-support@proton.me",
    hours:    "ПН–ПТ 09:00–00:00 МСК",
    discord:  "https://discord.gg/7pJcgXMPKj",
    telegram: "https://t.me/Snowdls"
  },

  video: {
    url: "",
    placeholder: {
      ru: "Видеообзор скоро появится",
      en: "Video review coming soon",
      uk: "Відеоогляд незабаром",
      pl: "Recenzja wideo wkrótce",
      tr: "Video inceleme yakında"
    }
  },

  features: {
    ru: [
      { title: "Продуманный интерфейс", desc: "Минималистичный HUD и ClickGUI без лишнего визуального шума. Настройка цветов, шрифтов и расположения элементов." },
      { title: "Система конфигураций",  desc: "Сохраняйте свои профили настроек и загружайте конфиги других игроков в один клик." },
      { title: "Оптимизация рендера",   desc: "Минимальная нагрузка на процессор и видеокарту. Стабильный фреймрейт в нагруженных сценах." },
      { title: "Регулярные патчи",      desc: "Оперативные обновления под актуальные версии и доработка модулей по отзывам пользователей." },
      { title: "Поддержка пользователей", desc: "Помощь с установкой, настройкой и привязкой HWID в рабочие часы в Discord и Telegram." },
      { title: "Защита аккаунта",       desc: "Привязка к ПК (HWID), шифрование сессии лаунчера и автоматическая выдача подписки после оплаты." }
    ]
    // остальные языки можно оставить аналогично
  },

  pricing: {
    currency: "₽",
    badge: { ru: "Популярный", en: "Popular", uk: "Популярний", pl: "Popularny", tr: "Popüler" },
    plans: [
      {
        id: "month",
        duration: { ru: "30 Дней", en: "30 Days", uk: "30 Днів", pl: "30 Dni", tr: "30 Gün" },
        price: 180,
        popular: false,
        features: { ru: ["Полный доступ к клиенту", "Автоматические обновления", "Стандартная поддержка"] }
      },
      {
        id: "3months",
        duration: { ru: "3 Месяца", en: "3 Months", uk: "3 Місяці", pl: "3 Miesiące", tr: "3 Ay" },
        price: 340,
        popular: true,
        features: { ru: ["Полный доступ к клиенту", "Автоматические обновления", "Приоритетная поддержка", "Доступ к тестовым сборкам"] }
      },
      {
        id: "6months",
        duration: { ru: "6 Месяцев", en: "6 Months", uk: "6 Місяців", pl: "6 Miesięcy", tr: "6 Ay" },
        price: 570,
        popular: false,
        features: { ru: ["Полный доступ к клиенту", "Автоматические обновления", "Приоритетная поддержка", "Доступ к тестовым сборкам"] }
      },
      {
        id: "lifetime",
        duration: { ru: "Навсегда", en: "Lifetime", uk: "Назавжди", pl: "Na zawsze", tr: "Ömür boyu" },
        price: 800,
        popular: false,
        features: { ru: ["Бессрочный доступ к клиенту", "Все будущие обновления", "Приоритетная поддержка", "Доступ к тестовым сборкам"] }
      }
    ]
  },

  payment: {
    funpayUrl: "https://funpay.com/lots/offer?id=78533148",
    methods: [
      { id: "cryptobot", name: "Crypto Bot", badge: "ВСЕ МОНЕТЫ", badgeColor: "#2563eb" },
      { id: "usdt",      name: "USDT",       badge: "USDT",       badgeColor: "#16a34a" },
      { id: "ton",       name: "TON",        badge: "TON",        badgeColor: "#0284c7" },
      { id: "btc",       name: "Bitcoin",    badge: "BTC",        badgeColor: "#f59e0b" },
      { id: "eth",       name: "Ethereum",   badge: "ETH",        badgeColor: "#6366f1" },
      { id: "ltc",       name: "Litecoin",   badge: "LTC",        badgeColor: "#64748b" }
    ]
  },

  i18n: {
    ru: {
      navBuy: "Купить",
      navLogin: "Войти",
      navCabinet: "Кабинет",
      cabTitle: "Личный кабинет",
      cabBackHome: "На главную",
      cabBuySub: "Купить подписку",
      cabSubActive: "Активна",
      cabSubInactive: "Не активна",
      cabTabOverview: "Обзор",
      cabTabClient: "Скачать клиент",
      cabTabKeys: "Ключи и оплата",
      cabTabSettings: "Настройки",
      cabCrumbRoot: "Кабинет",
      cabTabClientShort: "Клиент",
      cabTabKeysShort: "Ключи",
      cabNavLocked: "Нужна подписка",
      cabQuickKey: "Активировать ключ",
      cabPurchases: "История подписок",
      cabNoPurchases: "Активных или прошлых подписок пока нет",
      cabGoClient: "К загрузке →",
      cabHwidLabel: "Привязка к ПК (HWID)",
      cabHwidBound: "Привязан",
      cabHwidUnbound: "Не привязан",
      cabHwidHint: "Привяжется при первом запуске клиента",
      cabLaunchesLabel: "Запусков клиента",
      cabLaunchesNever: "Запусков ещё не было",
      cabLaunchesLast: "Последний запуск: ",
      clientTitle: "SnowClient · 1.21.11",
      clientDesc: "Загрузите актуальный билд лоадера для Windows 10/11 (x64).",
      clientBtnDownload: "Скачать SnowClient.exe",
      clientStarted: "Загрузка SnowClient.exe началась",
      clientNoSubTitle: "Нет активной подписки",
      clientNoSubDesc: "Оформите подписку или активируйте ключ во вкладке «Ключи и оплата».",
      step1Title: "Запустите лоадер",
      step1Desc: "Откройте SnowClient.exe от имени администратора. Зависимости загрузятся автоматически.",
      step2Title: "Авторизуйтесь",
      step2Desc: "Войдите под логином и паролем сайта. HWID привяжется к текущему ПК.",
      step3Title: "Запустите игру",
      step3Desc: "Укажите объём RAM в настройках лоадера и нажмите «Играть».",
      cabKey: "Активация ключа",
      cabKeyHint: "Введите ключ формата SNW-XXXX-XXXX-XXXX для мгновенной активации.",
      cabKeyPh: "SNW-XXXX-XXXX-XXXX",
      cabActivate: "Активировать",
      cabKeyOk: "Ключ активирован: ",
      cabKeyEmpty: "Введите ключ",
      cabFunpayTitle: "Покупка подписки",
      cabFunpayDesc: "Прямая оплата криптовалютой (автовыдача) или покупка ключа через FunPay.",
      cabProfileSettings: "Профиль",
      cabDisplayName: "Никнейм",
      cabAvatarUpload: "Загрузить аватар",
      cabAvatarRemove: "Удалить",
      cabAvatarHint: "PNG, JPG, GIF или WebP, до 2 МБ",
      cabAvatarSaved: "Аватар обновлён",
      cabAvatarRemoved: "Аватар удалён",
      cabNameLocked: "Никнейм фиксирован и используется для входа в клиент",
      cabAvatarBad: "Допустимы PNG, JPG, GIF или WebP до 2 МБ",
      cabChangePass: "Безопасность",
      cabCurPass: "Текущий пароль",
      cabNewPass: "Новый пароль (мин. 8 символов)",
      cabUpdatePass: "Изменить пароль",
      cabPassChanged: "Пароль обновлён",
      cabLogout: "Выйти",
      cabAdmin: "Админ-панель",
      cabForever: "Бессрочно",
      cabUntil: "до ",
      cabExpired: "Истекла",
      roleUser: "Пользователь",
      roleAdmin: "Администратор",
      roleModerator: "Модератор",
      roleBeta: "Бета-тестер",
      authShort: "Минимум 8 символов"
    }
  }
};