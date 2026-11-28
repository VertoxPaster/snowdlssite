import base64
import calendar
import hashlib
import hmac
import http.server
import math
import struct
import json
import mimetypes
import os
import re
import secrets
import threading
import psycopg2
import psycopg2.extras
import psycopg2.errors
import psycopg2.pool
import sys
import traceback
import time
import urllib.request
import urllib.parse
import urllib.error
from urllib.parse import urlsplit, unquote
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

ROOT = os.path.dirname(os.path.abspath(__file__))
SITE_URL = os.environ.get("SITE_URL", "").rstrip("/")
TRUST_PROXY = os.environ.get("TRUST_PROXY", "0") == "1"  # 1 только если перед сервером стоит доверенный reverse-proxy
DATABASE_URL = os.environ["DATABASE_URL"]
PORT = int(os.environ.get("PORT", "8080"))
MAX_JSON = 64 * 1024
MAX_UPLOAD = 3 * 1024 * 1024
UPLOAD_PATHS = ("/api/profile/me/avatar", "/api/profile/me/cover")
MIN_PW, MAX_PW = 8, 128
LOADER_TTL = 300  # 5 минут, одноразовый токен
TERMS_VERSION = "2026-11-24"
# Токен лоадера (scope='loader') может вызывать только скачивание лоадера и обмен сессии
LOADER_ALLOWED = {
    ("GET", "/api/loader/download"),
}

_db_lock = threading.RLock()
_pool = psycopg2.pool.ThreadedConnectionPool(1, 8, DATABASE_URL)
_pool_sem = threading.BoundedSemaphore(8)


def _run(sql, params=(), want_rows=True):
    with _pool_sem:
        return _run_inner(sql, params, want_rows)


def _run_inner(sql, params=(), want_rows=True):
    sql = sql.replace("?", "%s")
    last = None
    for attempt in range(2):
        conn = _pool.getconn()
        try:
            conn.autocommit = True
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(sql, params)
                rows = cur.fetchall() if (want_rows and cur.description) else []
            _pool.putconn(conn)
            return rows
        except (psycopg2.OperationalError, psycopg2.InterfaceError) as e:
            last = e
            _pool.putconn(conn, close=True)
        except Exception:
            _pool.putconn(conn)
            raise
    raise last


def _db(sql, params=()):
    return _run(sql, params)


def _db1(sql, params=()):
    rows = _db(sql, params)
    return rows[0] if rows else None


def _exec_script(script):
    for stmt in [x.strip() for x in script.split(";") if x.strip()]:
        _run(stmt, (), False)


def init_db():
    _exec_script(
        """
        CREATE TABLE IF NOT EXISTS users(
            id SERIAL PRIMARY KEY,
            username TEXT UNIQUE NOT NULL,
            email TEXT UNIQUE NOT NULL,
            pass_hash TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'user',
            balance DOUBLE PRECISION NOT NULL DEFAULT 0,
            total_deposits DOUBLE PRECISION NOT NULL DEFAULT 0,
            total_purchases DOUBLE PRECISION NOT NULL DEFAULT 0,
            display_name TEXT DEFAULT '',
            bio TEXT DEFAULT '',
            avatar TEXT DEFAULT '',
            cover TEXT DEFAULT '',
            ref_code TEXT,
            ref_uses INTEGER NOT NULL DEFAULT 0,
            ref_earned DOUBLE PRECISION NOT NULL DEFAULT 0,
            hwid TEXT DEFAULT '',
            hwid_bound_at TEXT DEFAULT '',
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS tokens(
            token TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS inventory(
            user_id INTEGER NOT NULL,
            cosmetic_id INTEGER NOT NULL,
            active INTEGER NOT NULL DEFAULT 0,
            granted_at TEXT NOT NULL,
            PRIMARY KEY(user_id, cosmetic_id)
        );
        CREATE TABLE IF NOT EXISTS purchases(
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL,
            product_id INTEGER NOT NULL,
            title TEXT,
            price DOUBLE PRECISION NOT NULL DEFAULT 0,
            source TEXT NOT NULL DEFAULT 'buy',
            purchased_at TEXT NOT NULL,
            expires_at TEXT
        );
        CREATE TABLE IF NOT EXISTS keys(
            key TEXT PRIMARY KEY,
            product_id INTEGER NOT NULL,
            created_by INTEGER,
            used_by INTEGER,
            used_at TEXT,
            created_at TEXT NOT NULL
        );
        """
    )


def _pbkdf2(pw, salt, it):
    return hashlib.pbkdf2_hmac("sha256", pw.encode(), salt.encode(), it).hex()


def hash_password(pw):
    salt = secrets.token_hex(16)
    return "i600000$%s$%s" % (salt, _pbkdf2(pw, salt, 600000))


def check_password(pw, stored):
    try:
        if stored.startswith("i"):
            it, salt, h = stored.split("$", 2)
            return secrets.compare_digest(_pbkdf2(pw, salt, int(it[1:])), h)
        salt, h = stored.split("$", 1)
        return secrets.compare_digest(_pbkdf2(pw, salt, 60000), h)
    except ValueError:
        return False


_DUMMY = {}


def _dummy_hash():
    # одинаковое время ответа для существующего и несуществующего пользователя
    if "h" not in _DUMMY:
        _DUMMY["h"] = hash_password(secrets.token_hex(8))
    return _DUMMY["h"]


def _th(token):
    """В БД хранится только SHA-256 токена: утечка таблицы tokens не даёт войти в аккаунты."""
    return hashlib.sha256(token.encode()).hexdigest()


def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + ".000Z"


def has_active_subscription(u):
    if not u:
        return False
    if u.get("role") in ("admin", "beta_tester", "moderator"):
        return True
    row = _db1(
        "SELECT id FROM purchases WHERE user_id=? AND (expires_at IS NULL OR expires_at='') LIMIT 1",
        (u["id"],),
    )
    if row:
        return True
    row_exp = _db1(
        "SELECT id FROM purchases WHERE user_id=? AND expires_at > ? LIMIT 1",
        (u["id"], now_iso()),
    )
    return bool(row_exp)


def user_json(u):
    name = u["username"]  # отображаемое имя всегда равно нику и не редактируется
    hwid_val = (u.get("hwid") or "").strip()
    return {
        "id": u["id"],
        "username": u["username"],
        "display_name": name,
        "displayName": name,
        "email": u["email"],
        "role": u["role"],
        "balance": u["balance"],
        "totalDeposits": u["total_deposits"],
        "totalPurchases": u["total_purchases"],
        "avatar": u["avatar"],
        "avatar_url": u["avatar"],
        "cover": u["cover"],
        "bio": u["bio"],
        "hwid": hwid_val,
        "hwid_bound_at": u.get("hwid_bound_at") or "",
        "has_subscription": has_active_subscription(u),
        "launch_count": int(u.get("launch_count") or 0),
        "last_launch_at": u.get("last_launch_at") or "",
        "is_blocked": False,
        "isBlocked": False,
        "is_verified": False,
        "created_at": u["created_at"],
        "presence": {"status": "online", "mode": "online", "online": True},
        "friendship_status": None,
    }


def public_user_json(u):
    d = user_json(u)
    for k in ("email", "balance", "totalDeposits", "totalPurchases", "hwid", "hwid_bound_at",
              "ref_code", "ref_uses", "ref_earned", "has_subscription", "is_blocked", "isBlocked",
              "launch_count", "last_launch_at"):
        d.pop(k, None)
    return d


def get_user_by_id(uid):
    return _db1("SELECT * FROM users WHERE id=?", (uid,))


TOKEN_TTL = 30 * 86400
ADMIN_MFA_TTL = 8 * 3600


def get_user_by_token(token):
    if not token or len(token) > 128:
        return None
    token = _th(token)
    row = _db1("SELECT user_id,created_at,mfa_at,scope FROM tokens WHERE token=?", (token,))
    if not row:
        return None
    try:
        born = calendar.timegm(time.strptime(row["created_at"][:19], "%Y-%m-%dT%H:%M:%S"))
    except ValueError:
        born = 0
    ttl = TOKEN_TTL if row["scope"] == "web" else LOADER_TTL
    if time.time() - born > ttl:
        _db("DELETE FROM tokens WHERE token=?", (token,))
        return None
    u = get_user_by_id(row["user_id"])
    if not u or u["banned"]:
        return None
    u = dict(u)
    u["_token"], u["_mfa_at"], u["_scope"] = token, float(row["mfa_at"] or 0), row["scope"]
    return u


_products_cache = {"t": 0, "data": None}
_cosmetics_cache = {"t": 0, "data": None}



def fetch_products():
    return [
        {"id": 1, "slug": "month",    "title": "SnowClient — 30 Дней",   "price": 180, "duration": 30},
        {"id": 2, "slug": "3months",  "title": "SnowClient — 3 Месяца",  "price": 340, "duration": 90},
        {"id": 3, "slug": "6months",  "title": "SnowClient — 6 Месяцев", "price": 570, "duration": 180},
        {"id": 4, "slug": "lifetime", "title": "SnowClient — Навсегда",  "price": 800, "duration": None},
        {"id": 5, "slug": "hwid",     "title": "Сброс HWID",             "price": 149, "duration": None, "type": "hwid_reset"},
    ]


def find_product(pid):
    if isinstance(pid, str):
        s = pid.strip().lower()
        for p in fetch_products():
            if p.get("slug") == s:
                return p
    try:
        num_id = int(pid or 0)
    except (TypeError, ValueError):
        return None
    for p in fetch_products():
        if int(p.get("id") or 0) == num_id:
            return p
    return None

def find_cosmetic(cid):
    try:
        cid = int(cid or 0)
    except (TypeError, ValueError):
        return None
    for c in fetch_cosmetics():
        if int(c.get("id") or 0) == cid:
            return c
    return None


EXPIRED_TS = "1970-01-01T00:00:00.000Z"


def is_hwid_reset(product):
    return (product or {}).get("type") == "hwid_reset"


def reset_user_hwid(user_id):
    _db("UPDATE users SET hwid='', hwid_bound_at='' WHERE id=?", (user_id,))


def grant_product(user_id, product, source):
    if is_hwid_reset(product):
        # Сброс HWID — НЕ подписка: пишем в историю уже «истёкшую» запись (иначе expires_at=NULL
        # означал бы Lifetime) и сбрасываем привязку к ПК.
        reset_user_hwid(user_id)
        _db(
            "INSERT INTO purchases(user_id,product_id,title,price,source,purchased_at,expires_at)"
            " VALUES(?,?,?,?,?,?,?)",
            (user_id, int(product.get("id") or 0), product.get("title") or "Сброс HWID",
             float(product.get("price") or 0), source, now_iso(), EXPIRED_TS),
        )
        return
    title = (product or {}).get("title") or "Подписка SnowClient"
    price = float((product or {}).get("price") or 0)
    duration = (product or {}).get("duration")
    expires = None
    if duration:
        expires = time.strftime(
            "%Y-%m-%dT%H:%M:%S", time.gmtime(time.time() + int(duration) * 86400)
        ) + ".000Z"
    _db(
        "INSERT INTO purchases(user_id,product_id,title,price,source,purchased_at,expires_at)"
        " VALUES(?,?,?,?,?,?,?)",
        (user_id, int((product or {}).get("id") or 0), title, price, source, now_iso(), expires),
    )
    role = (product or {}).get("grant_role")
    if role in ("beta_tester", "moderator"):
        _db("UPDATE users SET role=? WHERE id=?", (role, user_id))


def get_balance(user_id):
    row = _db1("SELECT balance,total_deposits,total_purchases FROM users WHERE id=?", (user_id,))
    if not row:
        return 0.0, 0.0, 0.0
    return float(row["balance"]), float(row["total_deposits"]), float(row["total_purchases"])


# ---------------------------------------------------------------- handlers

ROUTES = {}
PREFIX_ROUTES = []
PROXY_PUBLIC_GET = ("/api/cosmetics/", "/api/products", "/api/public/")


def route(method, path):
    def deco(fn):
        ROUTES[(method, path)] = fn
        return fn

    return deco


def proute(method, pattern):
    def deco(fn):
        PREFIX_ROUTES.append((method, re.compile(pattern), fn))
        return fn

    return deco


def require(user):
    return user is not None


def add_balance(uid, amount, deposit=True):
    if deposit:
        _db(
            "UPDATE users SET balance=balance+?, total_deposits=total_deposits+? WHERE id=?",
            (amount, amount, uid),
        )
    else:
        _db("UPDATE users SET balance=balance+? WHERE id=?", (amount, uid))


# ---------------------------------------------------------------- LAUNCHER API (HWID BINDING)

# ---------------------------------------------------------------- LAUNCHER API (HWID BINDING)

def _client_hashes() -> dict:
    stub_h = os.environ.get("STUB_SHA256", "").strip().lower()
    pak_h = os.environ.get("PAK_SHA256", "").strip().lower()
    dll_h = os.environ.get("DLL_SHA256", "").strip().lower()
    manifest_path = os.path.join(ROOT, "manifest.json")
    if (not stub_h or not pak_h) and os.path.isfile(manifest_path):
        try:
            with open(manifest_path, "r", encoding="utf-8") as f:
                m = json.load(f)
            stub_h = stub_h or str(m.get("stubSha256") or "").strip().lower()
            pak_h = pak_h or str(m.get("pakSha256") or "").strip().lower()
            dll_h = dll_h or str(m.get("dllSha256") or "").strip().lower()
        except Exception:
            pass
    return {
        "stub_sha256": stub_h,
        "pak_sha256": pak_h,
        "dll_sha256": dll_h,
    }


def _bind_or_verify_hwid(user_id: int, hwid: str) -> bool:
    bound = _db1(
        "UPDATE users SET hwid=?, hwid_bound_at=? WHERE id=? AND (hwid IS NULL OR hwid='') RETURNING hwid",
        (hwid, now_iso(), user_id),
    )
    if bound:
        return True
    row = _db1("SELECT hwid FROM users WHERE id=?", (user_id,))
    saved_hwid = ((row or {}).get("hwid") or "").strip()
    return bool(saved_hwid) and secrets.compare_digest(saved_hwid, hwid)


def note_launch(user_id: int) -> None:
    """+1 к счётчику запусков клиента (вызывается только после успешной проверки логина, подписки и HWID)."""
    _db("UPDATE users SET launch_count=launch_count+1, last_launch_at=? WHERE id=?", (now_iso(), user_id))


def make_key_envelope(hwid: str, nonce_hex: str) -> str:
    master_key = bytes.fromhex(os.environ["MOD_MASTER_KEY"])
    transport_key = bytes.fromhex(os.environ["DLL_TRANSPORT_KEY"])

    msg = f"{hwid}:{nonce_hex}".encode("utf-8")
    wrap_key = hmac.new(transport_key, msg, hashlib.sha256).digest()

    iv = os.urandom(12)
    aad = nonce_hex.encode("utf-8")
    ct_and_tag = AESGCM(wrap_key).encrypt(iv, master_key, aad)

    ciphertext = ct_and_tag[:-16]
    tag = ct_and_tag[-16:]
    envelope = iv + tag + ciphertext
    return base64.b64encode(envelope).decode("ascii")


@route("POST", "/api/launcher/auth")
def launcher_auth(h, body, user):
    if not isinstance(body, dict):
        return h.json_out({"status": "error", "message": "Некорректный формат запроса"}, 400)

    ident = str(body.get("username") or body.get("email") or "").strip()
    password = str(body.get("password") or "")
    hwid = str(body.get("hwid") or "").strip()
    nonce = str(body.get("nonce") or "").strip().lower()

    if not ident or not password:
        return h.json_out({"status": "error", "message": "Введите логин и пароль"}, 400)
    if not hwid or len(hwid) < 4 or len(hwid) > 128:
        return h.json_out({"status": "error", "message": "Некорректный HWID устройства"}, 400)
    if not re.fullmatch(r"[0-9a-f]{32}", nonce):
        return h.json_out({"status": "error", "message": "Некорректный nonce сессии"}, 400)
    if len(password) > MAX_PW or len(ident) > 254:
        return h.json_out({"status": "error", "message": "Неверный логин или пароль"}, 401)

    k_ip = "lnc_ip:" + h.client_ip()
    k_id = "lnc_id:" + ident.lower()
    if throttled(k_ip, 25, 900) or throttled(k_id, 10, 900):
        return h.json_out({"status": "error", "message": "Слишком много попыток. Подождите 15 минут"}, 429)

    u = _db1(
        "SELECT * FROM users WHERE lower(username)=lower(?) OR lower(email)=lower(?)",
        (ident, ident),
    )
    pw_ok = check_password(password, u["pass_hash"] if u else _dummy_hash())
    if not u or not pw_ok:
        note_fail(k_ip)
        note_fail(k_id)
        return h.json_out({"status": "error", "message": "Неверный логин или пароль"}, 401)

    if u["banned"]:
        return h.json_out({"status": "error", "message": "Аккаунт заблокирован"}, 403)

    if not has_active_subscription(u):
        return h.json_out({"status": "error", "message": "Нет активной подписки. Оформите на сайте"}, 403)

    if not _bind_or_verify_hwid(u["id"], hwid):
        return h.json_out(
            {"status": "error", "message": "Аккаунт привязан к другому ПК (HWID mismatch)"},
            403,
        )

    note_launch(u["id"])
    return h.json_out({
        "status": "ok",
        "username": u["username"],
        "role": u["role"],
        "key_envelope": make_key_envelope(hwid, nonce),
        **_client_hashes(),
    })


@route("POST", "/api/launcher/web-session")
def launcher_web_session(h, body, user):
    if not isinstance(body, dict):
        return h.json_out({"status": "error", "message": "Некорректный формат запроса"}, 400)

    token = str(body.get("token") or "").strip()
    hwid = str(body.get("hwid") or "").strip()
    nonce = str(body.get("nonce") or "").strip().lower()

    u = user or get_user_by_token(token)
    if not u:
        return h.json_out({"status": "error", "message": "Сессия сайта недействительна"}, 401)
    if not hwid or len(hwid) < 4 or len(hwid) > 128:
        return h.json_out({"status": "error", "message": "Некорректный HWID устройства"}, 400)
    if not re.fullmatch(r"[0-9a-f]{32}", nonce):
        return h.json_out({"status": "error", "message": "Некорректный nonce сессии"}, 400)
    if u["banned"]:
        return h.json_out({"status": "error", "message": "Аккаунт заблокирован"}, 403)
    if not has_active_subscription(u):
        return h.json_out({"status": "error", "message": "Нет активной подписки"}, 403)

    # Одноразовый loader-токен сгорает сразу при обмене на игровую сессию
    if u.get("_scope") == "loader":
        burned = _db1("DELETE FROM tokens WHERE token=? AND scope='loader' RETURNING token", (u["_token"],))
        if not burned:
            return h.json_out({"status": "error", "message": "Токен уже использован"}, 401)

    if not _bind_or_verify_hwid(u["id"], hwid):
        return h.json_out({"status": "error", "message": "Аккаунт привязан к другому ПК (HWID mismatch)"}, 403)

    note_launch(u["id"])
    return h.json_out({
        "status": "ok",
        "username": u["username"],
        "role": u["role"],
        "key_envelope": make_key_envelope(hwid, nonce),
        **_client_hashes(),
    })

_pub_stats = {"t": 0, "data": None}


@route("GET", "/api/public/stats")
def public_stats(h, body, user):
    now = time.time()
    if not _pub_stats["data"] or now - _pub_stats["t"] > 30:
        r = _db1("SELECT COUNT(*) AS users, COALESCE(SUM(launch_count),0) AS launches FROM users")
        _pub_stats["data"] = {"users": int(r["users"]), "launches": int(r["launches"])}
        _pub_stats["t"] = now
    return h.json_out({"success": True, "data": _pub_stats["data"]})


@route("GET", "/api/loader/download")
def loader_download(h, body, user):
    if not require(user):
        return h.json_out({"message": "Сначала войдите в аккаунт"}, 401)
    if not has_active_subscription(user):
        return h.json_out({"message": "Для скачивания клиента нужна активная подписка"}, 403)

    ext_url = os.environ.get("LOADER_URL", "").strip()
    want_json = "application/json" in (h.headers.get("Accept") or "")

    if ext_url:
        if want_json:
            return h.json_out({"success": True, "url": ext_url, "filename": "SnowClient.exe"})
        h.send_response(302)
        h.send_header("Location", ext_url)
        h.end_headers()
        return

    local_exe = os.path.join(ROOT, "static", "SnowClient.exe")
    if os.path.isfile(local_exe):
        if want_json:
            return h.json_out({"success": True, "direct": True, "filename": "SnowClient.exe"})
        size = os.path.getsize(local_exe)
        h.send_response(200)
        h.send_header("Content-Type", "application/octet-stream")
        h.send_header("Content-Disposition", 'attachment; filename="SnowClient.exe"')
        h.send_header("Content-Length", str(size))
        h.end_headers()
        with open(local_exe, "rb") as f:
            while True:
                chunk = f.read(65536)
                if not chunk:
                    break
                h.wfile.write(chunk)
        return

    return h.json_out({
        "message": "Файл клиента ещё не загружен на сервер (добавьте static/SnowClient.exe или LOADER_URL)"
    }, 404)


# ---------------------------------------------------------------- AUTH & SITE API

@route("POST", "/api/auth/register")
def auth_register(h, body, user):
    username = str(body.get("username") or "").strip()
    email = str(body.get("email") or "").strip().lower()
    password = str(body.get("password") or "")
    if not re.fullmatch(r"[A-Za-z0-9_]{3,20}", username):
        return h.json_out({"message": "Ник: 3-20 символов (латиница, цифры, _)"}, 400)
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
        return h.json_out({"message": "Некорректный email"}, 400)
    if len(email) > 254:
        return h.json_out({"message": "Некорректный email"}, 400)
    if len(password) < MIN_PW or len(password) > MAX_PW:
        return h.json_out({"message": "Пароль: от %d до %d символов" % (MIN_PW, MAX_PW)}, 400)
    if body.get("acceptTerms") is not True:
        return h.json_out({"message": "Необходимо принять пользовательское соглашение"}, 400)
    if throttled("reg:" + h.client_ip(), 5, 3600):
        return h.json_out({"message": "Слишком много регистраций, попробуйте позже"}, 429)
    note_fail("reg:" + h.client_ip())
    if _db1("SELECT id FROM users WHERE lower(username)=lower(?) OR lower(email)=lower(?)", (username, email)):
        return h.json_out({"message": "Пользователь с таким ником или email уже существует"}, 400)
    # Первый админ: нужны и ник, и email из окружения (иначе его мог бы занять первый зашедший)
    boot_u = os.environ.get("ADMIN_USERNAME", "").lower()
    boot_e = os.environ.get("ADMIN_EMAIL", "").lower()
    is_boot = bool(boot_u and boot_e and username.lower() == boot_u and email == boot_e
                   and not _db1("SELECT 1 FROM users WHERE role='admin'"))
    role = "admin" if is_boot else "user"
    try:
        uid = _db1(
            "INSERT INTO users(username,email,pass_hash,role,created_at,terms_accepted_at,terms_version)"
            " VALUES(?,?,?,?,?,?,?) RETURNING id",
            (username, email, hash_password(password), role, now_iso(), now_iso(), TERMS_VERSION),
        )["id"]
    except psycopg2.errors.UniqueViolation:
        return h.json_out({"message": "Пользователь с таким ником или email уже существует"}, 400)
    token = secrets.token_hex(32)
    _db("INSERT INTO tokens(token,user_id,created_at) VALUES(?,?,?)", (_th(token), uid, now_iso()))
    u = get_user_by_id(uid)
    return h.json_out({"success": True, "token": token, "user": user_json(u), "data": {"token": token, "user": user_json(u)}})


@route("POST", "/api/auth/login")
def auth_login(h, body, user):
    password = str(body.get("password") or "")
    ident = str(body.get("email") or "").strip()
    if len(password) > MAX_PW or len(ident) > 254:
        return h.json_out({"message": "Неверный email или пароль"}, 401)
    u = _db1("SELECT * FROM users WHERE lower(email)=lower(?) OR lower(username)=lower(?)", (ident, ident))
    k1, k2 = "ip:" + h.client_ip(), "id:" + ident.lower()
    if throttled(k1, 20) or throttled(k2, 5):
        return h.json_out({"message": "Слишком много попыток. Подождите 15 минут"}, 429)
    pw_ok = check_password(password, u["pass_hash"] if u else _dummy_hash())
    if not u or not pw_ok:
        note_fail(k1)
        note_fail(k2)
        return h.json_out({"message": "Неверный email или пароль"}, 401)
    if u["banned"]:
        return h.json_out({"message": "Аккаунт заблокирован"}, 403)
    if not u["pass_hash"].startswith("i"):
        _db("UPDATE users SET pass_hash=? WHERE id=?", (hash_password(password), u["id"]))
    token = secrets.token_hex(32)
    _db("INSERT INTO tokens(token,user_id,created_at) VALUES(?,?,?)", (_th(token), u["id"], now_iso()))
    return h.json_out({"success": True, "token": token, "user": user_json(u), "data": {"token": token, "user": user_json(u)}})


@route("GET", "/api/auth/me")
def auth_me(h, body, user):
    if not require(user):
        return h.json_out({"message": "Не авторизован"}, 401)
    return h.json_out({"success": True, "data": user_json(user), "user": user_json(user)})


@route("POST", "/api/auth/logout")
def auth_logout(h, body, user):
    token = h.bearer_token()
    if token:
        _db("DELETE FROM tokens WHERE token=?", (_th(token),))
    return h.json_out({"success": True})


@route("POST", "/api/auth/loader-token")
def loader_token(h, body, user):
    """Отдельный короткоживущий токен для лоадера: сайтовый токен (30 дней) наружу не отдаём."""
    if not require(user) or user.get("_scope") != "web":
        return h.json_out({"message": "Не авторизован"}, 401)
    if throttled("ltok:%s" % user["id"], 20, 3600):
        return h.json_out({"message": "Слишком много запросов"}, 429)
    note_fail("ltok:%s" % user["id"])
    token = secrets.token_hex(32)
    _db("DELETE FROM tokens WHERE user_id=? AND scope='loader'", (user["id"],))
    _db("INSERT INTO tokens(token,user_id,created_at,scope) VALUES(?,?,?,'loader')",
        (_th(token), user["id"], now_iso()))
    return h.json_out({"success": True, "token": token, "expires_in": LOADER_TTL})


@route("PUT", "/api/auth/password")
def auth_password(h, body, user):
    if not require(user):
        return h.json_out({"message": "Не авторизован"}, 401)
    cur_pw = str(body.get("currentPassword") or "")
    new_pw = str(body.get("newPassword") or "")
    if throttled("pw:%s" % user["id"], 5, 900):
        return h.json_out({"message": "Слишком много попыток. Подождите 15 минут"}, 429)
    if len(cur_pw) > MAX_PW or not check_password(cur_pw, user["pass_hash"]):
        note_fail("pw:%s" % user["id"])
        return h.json_out({"message": "Текущий пароль неверен"}, 400)
    if len(new_pw) < MIN_PW or len(new_pw) > MAX_PW:
        return h.json_out({"message": "Новый пароль: от %d до %d символов" % (MIN_PW, MAX_PW)}, 400)
    _db("UPDATE users SET pass_hash=? WHERE id=?", (hash_password(new_pw), user["id"]))
    _db("DELETE FROM tokens WHERE user_id=? AND token<>?", (user["id"], user["_token"]))
    return h.json_out({"success": True})


@route("POST", "/api/auth/telegram/generate-code")
def tg_generate(h, body, user):
    if not require(user):
        return h.json_out({"message": "Не авторизован"}, 401)
    return h.json_out({"success": True, "code": "000000", "data": {"code": "000000"}})


@route("GET", "/api/auth/telegram/status")
def tg_status(h, body, user):
    if not require(user):
        return h.json_out({"message": "Не авторизован"}, 401)
    return h.json_out({"success": True, "linked": False, "status": "unlinked", "data": {"linked": False}})


@route("DELETE", "/api/auth/telegram/unlink")
def tg_unlink(h, body, user):
    if not require(user):
        return h.json_out({"message": "Не авторизован"}, 401)
    return h.json_out({"success": True})


@route("POST", "/api/auth/forgot-password")
def forgot(h, body, user):
    return h.json_out({"success": True, "method": "email"})


@route("GET", "/api/balance")
def balance_get(h, body, user):
    if not require(user):
        return h.json_out({"message": "Не авторизован"}, 401)
    b, dep, pur = get_balance(user["id"])
    d = {"balance": b, "totalDeposits": dep, "totalPurchases": pur}
    return h.json_out({"success": True, "data": dict(d), **d})


@route("POST", "/api/balance/purchase-product")
def purchase_product(h, body, user):
    if not require(user):
        return h.json_out({"message": "Не авторизован"}, 401)
    pid = body.get("productId")
    prod = find_product(pid)
    if not prod:
        return h.json_out({"message": "Товар не найден"}, 400)
    price = float(prod.get("price") or 0)
    if is_hwid_reset(prod) and not (user.get("hwid") or "").strip():
        return h.json_out({"message": "HWID не привязан — сбрасывать нечего"}, 400)
    ok = _db1(
        "UPDATE users SET balance=balance-?, total_purchases=total_purchases+?"
        " WHERE id=? AND balance>=? RETURNING id",
        (price, price, user["id"], price),
    )
    if not ok:
        b, dep, pur = get_balance(user["id"])
        return h.json_out(
            {"message": "Недостаточно средств. Требуется: %.2f ₽, у вас: %.2f ₽" % (price, b)}, 400
        )
    grant_product(user["id"], prod, "buy")
    b, dep, pur = get_balance(user["id"])
    d = {"balance": b}
    return h.json_out({"success": True, "message": "Товар успешно приобретен", "data": dict(d), **d})


@route("POST", "/api/balance/purchase-cosmetic")
def purchase_cosmetic(h, body, user):
    if not require(user):
        return h.json_out({"message": "Не авторизован"}, 401)
    cid = body.get("cosmeticId")
    try:
        cid = int(cid)
    except (TypeError, ValueError):
        return h.json_out({"message": "Некорректный товар"}, 400)
    if _db1("SELECT 1 FROM inventory WHERE user_id=? AND cosmetic_id=?", (user["id"], cid)):
        return h.json_out({"message": "Эта косметика уже у вас"}, 400)
    cos = find_cosmetic(cid)
    if not cos:
        return h.json_out({"message": "Косметика не найдена"}, 400)
    price = float(cos.get("price") or 0)
    ok = _db1(
        "UPDATE users SET balance=balance-?, total_purchases=total_purchases+?"
        " WHERE id=? AND balance>=? RETURNING id",
        (price, price, user["id"], price),
    )
    if not ok:
        b, dep, pur = get_balance(user["id"])
        return h.json_out(
            {"message": "Недостаточно средств. Требуется: %.2f ₽, у вас: %.2f ₽" % (price, b)}, 400
        )
    _db(
        "INSERT INTO inventory(user_id,cosmetic_id,active,granted_at) VALUES(?,?,0,?)"
        " ON CONFLICT DO NOTHING",
        (user["id"], cid, now_iso()),
    )
    b, dep, pur = get_balance(user["id"])
    d = {"balance": b}
    return h.json_out({"success": True, "message": "Косметика приобретена", "data": dict(d), **d})


@route("GET", "/api/profile/me")
def profile_me(h, body, user):
    if not require(user):
        return h.json_out({"message": "Не авторизован"}, 401)
    return h.json_out({"success": True, "data": user_json(user), "user": user_json(user)})


@route("PATCH", "/api/profile/me")
def profile_patch(h, body, user):
    if not require(user):
        return h.json_out({"message": "Не авторизован"}, 401)
    # Отображаемое имя и ник менять нельзя (имя = ник)
    for k in ("display_name", "displayName", "display-name", "username"):
        if k in body:
            return h.json_out({"message": "Имя и ник изменить нельзя"}, 403)
    mapping = {
        "bio": "bio",
    }
    for k, col in mapping.items():
        if k in body and body[k] is not None:
            val = str(body[k]).strip()
            if col == "username":
                if not re.fullmatch(r"[A-Za-z0-9_]{3,20}", val):
                    return h.json_out({"message": "Ник: 3-20 символов (латиница, цифры, _)"}, 400)
                if _db1("SELECT id FROM users WHERE lower(username)=lower(?) AND id<>?", (val, user["id"])):
                    return h.json_out({"message": "Ник занят"}, 400)
            if col in ("display_name", "bio"):
                val = re.sub(r"[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]", "", val)
            if col == "display_name" and len(val) > 32:
                return h.json_out({"message": "Display Name максимум 32 символа"}, 400)
            if col == "bio" and len(val) > 500:
                return h.json_out({"message": "Bio максимум 500 символов"}, 400)
            try:
                _db("UPDATE users SET %s=? WHERE id=?" % col, (val, user["id"]))
            except psycopg2.errors.UniqueViolation:
                return h.json_out({"message": "Ник занят"}, 400)
    u = get_user_by_id(user["id"])
    return h.json_out({"success": True, "data": user_json(u), "user": user_json(u)})


def _rm_upload(rel):
    if rel and rel.startswith("/uploads/local/"):
        p = os.path.join(ROOT, "uploads", "local", os.path.basename(rel))
        try:
            os.remove(p)
        except OSError:
            pass


def _upload_limited(h, user):
    if throttled("up:%s" % user["id"], 10, 3600):
        h.json_out({"message": "Слишком много загрузок, попробуйте позже"}, 429)
        return True
    note_fail("up:%s" % user["id"])
    return False


def save_upload(h, body, field):
    ctype = h.headers.get("Content-Type", "")
    if not body or "multipart/form-data" not in ctype:
        return None
    m = re.search(r'boundary="?([^";]+)"?', ctype)
    if not m:
        return None
    boundary = b"--" + m.group(1).encode()
    for part in body.split(boundary):
        if b"Content-Disposition" not in part:
            continue
        header, _, data = part.partition(b"\r\n\r\n")
        if not re.search(rb'name="%s"' % field.encode(), header):
            continue
        data = data.rstrip(b"\r\n")
        if not data:
            continue
        if len(data) > 2 * 1024 * 1024:
            return None
        if data.startswith(b"\x89PNG\r\n\x1a\n"):
            ext = ".png"
        elif data.startswith(b"\xff\xd8\xff"):
            ext = ".jpg"
        elif data[:6] in (b"GIF87a", b"GIF89a"):
            ext = ".gif"
        elif data[:4] == b"RIFF" and data[8:12] == b"WEBP":
            ext = ".webp"
        else:
            return None  # не картинка
        rel = "/uploads/local/%s_%s%s" % (field, secrets.token_hex(8), ext)
        abs_path = os.path.join(ROOT, "uploads", "local")
        os.makedirs(abs_path, exist_ok=True)
        with open(os.path.join(abs_path, os.path.basename(rel)), "wb") as f:
            f.write(data)
        return rel
    return None


@route("POST", "/api/profile/me/avatar")
def profile_avatar(h, body, user):
    if not require(user):
        return h.json_out({"message": "Не авторизован"}, 401)
    if _upload_limited(h, user):
        return
    rel = save_upload(h, body, "avatar")
    if not rel:
        return h.json_out({"message": "Файл не получен"}, 400)
    _rm_upload(user["avatar"])
    _db("UPDATE users SET avatar=? WHERE id=?", (rel, user["id"]))
    u = get_user_by_id(user["id"])
    return h.json_out({"success": True, "avatar": rel, "data": {"avatar": rel, "user": user_json(u)}, "user": user_json(u)})


@route("DELETE", "/api/profile/me/avatar")
def profile_avatar_delete(h, body, user):
    if not require(user):
        return h.json_out({"message": "Не авторизован"}, 401)
    _rm_upload(user["avatar"])
    _db("UPDATE users SET avatar='' WHERE id=?", (user["id"],))
    u = get_user_by_id(user["id"])
    return h.json_out({"success": True, "avatar": "", "data": {"avatar": "", "user": user_json(u)}, "user": user_json(u)})


@route("POST", "/api/profile/me/cover")
def profile_cover(h, body, user):
    if not require(user):
        return h.json_out({"message": "Не авторизован"}, 401)
    if _upload_limited(h, user):
        return
    rel = save_upload(h, body, "cover")
    if not rel:
        return h.json_out({"message": "Файл не получен"}, 400)
    _rm_upload(user["cover"])
    _db("UPDATE users SET cover=? WHERE id=?", (rel, user["id"]))
    u = get_user_by_id(user["id"])
    return h.json_out({"success": True, "cover": rel, "data": {"cover": rel, "user": user_json(u)}, "user": user_json(u)})


@route("PATCH", "/api/profile/me/presence")
def profile_presence(h, body, user):
    if not require(user):
        return h.json_out({"message": "Не авторизован"}, 401)
    mode = body.get("mode")
    return h.json_out({"success": True, "mode": mode, "data": {"mode": mode}})


@route("GET", "/api/cosmetics/user/my")
def cosmetics_my(h, body, user):
    if not require(user):
        return h.json_out({"message": "Не авторизован"}, 401)
    rows = _db("SELECT cosmetic_id,active FROM inventory WHERE user_id=? ORDER BY granted_at", (user["id"],))
    cat = {int(c["id"]): c for c in fetch_cosmetics()}
    out = []
    for r in rows:
        cid = r["cosmetic_id"]
        c = dict(cat.get(cid) or {"id": cid, "name": "Косметика #%d" % cid, "type": "unknown", "price": 0})
        c["cosmetic_id"] = cid
        c["is_active"] = 1 if r["active"] else 0
        c["activated"] = bool(r["active"])
        out.append(c)
    return h.json_out({"success": True, "data": out, "cosmetics": out, "count": len(out)})


@proute("PUT", r"^/api/cosmetics/user/(\d+)/(activate|deactivate)$")
def cosmetics_toggle(h, mo, body, user):
    if not require(user):
        return h.json_out({"message": "Не авторизован"}, 401)
    cid, action = int(mo.group(1)), mo.group(2)
    if not _db1("SELECT 1 FROM inventory WHERE user_id=? AND cosmetic_id=?", (user["id"], cid)):
        return h.json_out({"message": "Косметика не куплена"}, 404)
    if action == "activate":
        cos = find_cosmetic(cid)
        ctype = (cos or {}).get("type")
        if ctype:
            same = [
                r["cosmetic_id"]
                for r in _db(
                    "SELECT i.cosmetic_id FROM inventory i WHERE i.user_id=? AND i.active=1", (user["id"],)
                )
                if (find_cosmetic(r["cosmetic_id"]) or {}).get("type") == ctype
            ]
            for other in same:
                _db("UPDATE inventory SET active=0 WHERE user_id=? AND cosmetic_id=?", (user["id"], other))
        _db("UPDATE inventory SET active=1 WHERE user_id=? AND cosmetic_id=?", (user["id"], cid))
    else:
        _db("UPDATE inventory SET active=0 WHERE user_id=? AND cosmetic_id=?", (user["id"], cid))
    active = 1 if action == "activate" else 0
    return h.json_out({"success": True, "data": {"id": cid, "is_active": active}})


@proute("GET", r"^/api/profile/([^/]+)$")
def profile_by_name(h, mo, body, user):
    if not require(user):
        return h.json_out({"message": "Не авторизован"}, 401)
    uname = unquote(mo.group(1))[:40]
    target = _db1("SELECT * FROM users WHERE lower(username)=lower(?)", (uname,))
    if not target:
        return h.json_out({"message": "Пользователь не найден"}, 404)
    pj = public_user_json(target)
    return h.json_out({"success": True, "data": pj, "user": pj})


@proute("GET", r"^/api/profile/([^/]+)/inventory$")
def profile_inventory(h, mo, body, user):
    if not require(user):
        return h.json_out({"message": "Не авторизован"}, 401)
    uname = unquote(mo.group(1))[:40]
    target = _db1("SELECT id FROM users WHERE lower(username)=lower(?)", (uname,))
    if not target:
        return h.json_out({"message": "Пользователь не найден"}, 404)
    rows = _db("SELECT cosmetic_id FROM inventory WHERE user_id=?", (target["id"],))
    cat = {int(c["id"]): c for c in fetch_cosmetics()}
    out = [dict(cat.get(r["cosmetic_id"]) or {"id": r["cosmetic_id"], "name": "Косметика #%d" % r["cosmetic_id"]}) for r in rows]
    return h.json_out({"success": True, "data": out, "count": len(out)})


@route("GET", "/api/friends")
def friends_list(h, body, user):
    if not require(user):
        return h.json_out({"message": "Не авторизован"}, 401)
    return h.json_out({"success": True, "data": [], "friends": [], "count": 0})


@route("GET", "/api/friends/requests")
def friends_requests(h, body, user):
    if not require(user):
        return h.json_out({"message": "Не авторизован"}, 401)
    return h.json_out({"success": True, "data": [], "requests": [], "incoming": [], "outgoing": [], "count": 0})


@route("POST", "/api/friends/requests")
def friends_add(h, body, user):
    if not require(user):
        return h.json_out({"message": "Не авторизован"}, 401)
    return h.json_out({"success": True, "data": {"status": "pending"}})


@proute("POST", r"^/api/friends/requests/[^/]+/accept$")
def friends_accept(h, mo, body, user):
    if not require(user):
        return h.json_out({"message": "Не авторизован"}, 401)
    return h.json_out({"success": True})


@proute("DELETE", r"^/api/friends/requests/[^/]+$")
def friends_reject(h, mo, body, user):
    if not require(user):
        return h.json_out({"message": "Не авторизован"}, 401)
    return h.json_out({"success": True})


def _has_paid(uid):
    return bool(_db1("SELECT 1 FROM purchases WHERE user_id=? AND source IN ('buy','key','pay') LIMIT 1", (uid,)))


@route("GET", "/api/daily-bonus/status")
def daily_status(h, body, user):
    if not require(user):
        return h.json_out({"message": "Не авторизован"}, 401)
    last = float(user["last_daily"] or 0)
    left = max(0, int(last + 86400 - time.time()))
    d = {
        "canClaim": left == 0 and _has_paid(user["id"]),
        "purchasePrice": 99,
        "paidOpensRemaining": 0,
        "timeUntilNext": left * 1000,
        "cards": [],
    }
    return h.json_out({"success": True, "data": dict(d), **d})


@route("POST", "/api/daily-bonus/claim")
def daily_claim(h, body, user):
    if not require(user):
        return h.json_out({"message": "Не авторизован"}, 401)
    if not _has_paid(user["id"]):
        return h.json_out({"message": "Бонус доступен после первой покупки или активации ключа"}, 403)
    amt = 5 + secrets.randbelow(46)
    now = time.time()
    ok = _db1(
        "UPDATE users SET balance=balance+?, total_deposits=total_deposits+?, last_daily=?"
        " WHERE id=? AND last_daily<=? RETURNING id",
        (amt, amt, now, user["id"], now - 86400),
    )
    if not ok:
        return h.json_out({"message": "Бонус уже получен, приходите позже"}, 400)
    reward = {
        "rarity": "common",
        "displayText": "+%d ₽" % amt,
        "displayDesc": "Ежедневный бонус",
        "isBurned": False,
        "type": "balance",
        "details": {"amount": amt},
    }
    return h.json_out({"success": True, "data": dict(reward), "reward": dict(reward), "claimed": True, "balance": get_balance(user["id"])[0]})


@route("POST", "/api/keys/activate")
def keys_activate(h, body, user):
    if not require(user):
        return h.json_out({"message": "Не авторизован"}, 401)
    key = str(body.get("key") or "").strip().upper()
    k_u, k_ip = "key_u:%s" % user["id"], "key_ip:" + h.client_ip()
    if throttled(k_u, 10, 900) or throttled(k_ip, 30, 900):
        return h.json_out({"message": "Слишком много попыток. Подождите 15 минут"}, 429)
    if not key or len(key) > 64:
        return h.json_out({"message": "Ключ недействителен или уже использован"}, 400)
    # ключ сброса HWID не сжигаем, если сбрасывать нечего
    peek = _db1("SELECT product_id FROM keys WHERE upper(key)=? AND used_by IS NULL", (key,))
    if peek and is_hwid_reset(find_product(peek["product_id"])) and not (user.get("hwid") or "").strip():
        return h.json_out({"message": "HWID не привязан — ключ сброса пока не нужен. Ключ не потрачен"}, 400)
    # атомарно «забираем» ключ: два одновременных запроса не активируют его дважды
    row = _db1(
        "UPDATE keys SET used_by=?, used_at=? WHERE upper(key)=? AND used_by IS NULL RETURNING key, product_id",
        (user["id"], now_iso(), key),
    )
    if not row:
        note_fail(k_u)
        note_fail(k_ip)
        return h.json_out({"message": "Ключ недействителен или уже использован"}, 400)
    prod = find_product(row["product_id"]) or {"id": row["product_id"], "title": "Подписка SnowClient #%s" % row["product_id"], "price": 0}
    try:
        grant_product(user["id"], prod, "key")
    except Exception:
        _db("UPDATE keys SET used_by=NULL, used_at=NULL WHERE key=?", (row["key"],))
        raise
    product = {"id": prod.get("id"), "title": prod.get("title")}
    return h.json_out({"success": True, "data": {"product": dict(product)}, "product": dict(product)})


@route("GET", "/api/creator-configs/my")
def creator_cfg(h, body, user):
    if not require(user):
        return h.json_out({"message": "Не авторизован"}, 401)
    return h.json_out({"success": True, "hasConfig": False, "data": {"hasConfig": False}})


@route("GET", "/api/creator-resource-packs/my")
def creator_packs(h, body, user):
    if not require(user):
        return h.json_out({"message": "Не авторизован"}, 401)
    return h.json_out({"success": True, "hasPacks": False, "data": {"hasPacks": False}})


CRYPTO_TOKEN = os.environ.get("CRYPTOBOT_TOKEN", "").strip()
CRYPTO_API = os.environ.get("CRYPTOBOT_API", "https://pay.crypt.bot/api").rstrip("/")
CRYPTO_ASSETS = {
    "cryptobot": "USDT,TON,BTC,ETH,LTC,TRX,USDC",
    "usdt": "USDT", "ton": "TON", "btc": "BTC", "eth": "ETH",
    "ltc": "LTC", "trx": "TRX", "usdc": "USDC",
}


def crypto_call(method, params=None, post=False):
    url = CRYPTO_API + "/" + method
    data = None
    if post:
        data = json.dumps(params or {}).encode()
    elif params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, data=data, headers={
        "Crypto-Pay-API-Token": CRYPTO_TOKEN, "Content-Type": "application/json",
        "Accept": "application/json", "User-Agent": "Mozilla/5.0 (SnowClient/1.0)"})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            j = json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        raise RuntimeError("cryptobot HTTP %s: %s" % (e.code, e.read()[:300].decode("utf-8", "replace")))
    if not j.get("ok"):
        raise RuntimeError("cryptobot: %s" % j.get("error"))
    return j["result"]


def promo_lookup(code, uid=None):
    code = str(code or "").strip().upper()[:32]
    if not code:
        return None, None
    p = _db1("SELECT * FROM promocodes WHERE code=?", (code,))
    if not p or not p["active"]:
        return None, "Промокод не найден"
    if p["expires_at"] and p["expires_at"] < now_iso():
        return None, "Срок действия промокода истёк"
    if p["max_uses"] and p["uses"] >= p["max_uses"]:
        return None, "Промокод закончился"
    if uid and _db1("SELECT 1 FROM promo_uses WHERE code=? AND user_id=?", (code, uid)):
        return None, "Вы уже использовали этот промокод"
    return p, None


def settle_payment(order_id):
    """Идемпотентно: подписка выдаётся ровно один раз, даже если статус опрашивают параллельно."""
    row = _db1("UPDATE payments SET status='paid', paid_at=? WHERE order_id=? AND status='pending' RETURNING *",
               (now_iso(), order_id))
    if not row:
        return False
    try:
        prod = dict(find_product(row["product_id"]) or {"id": row["product_id"], "title": "Подписка SnowClient", "duration": None})
        prod["price"] = row["amount"]
        grant_product(row["user_id"], prod, "pay")
    except Exception:
        _db("UPDATE payments SET status='pending', paid_at=NULL WHERE order_id=?", (order_id,))
        raise
    if row["promo"]:
        d = _db1("SELECT discount FROM promocodes WHERE code=?", (row["promo"],))
        _db("UPDATE promocodes SET uses=uses+1 WHERE code=?", (row["promo"],))
        _db("INSERT INTO promo_uses(code,user_id,order_id,discount,amount,used_at) VALUES(?,?,?,?,?,?)",
            (row["promo"], row["user_id"], order_id, int(d["discount"]) if d else 0, row["amount"], now_iso()))
    return True


@route("POST", "/api/payments/create")
def payments_create(h, body, user):
    if not require(user):
        return h.json_out({"message": "Сначала войдите в аккаунт"}, 401)
    if not CRYPTO_TOKEN:
        return h.json_out({"message": "Оплата криптой временно недоступна. Используйте FunPay"}, 400)
    k = "pay:%s" % user["id"]
    if throttled(k, 10, 600):
        return h.json_out({"message": "Слишком много попыток, подождите немного"}, 429)
    note_fail(k)
    prod = find_product(body.get("planId") or body.get("productId"))
    if not prod:
        return h.json_out({"message": "Тариф не найден"}, 400)
    assets = CRYPTO_ASSETS.get(str(body.get("method") or "cryptobot").strip().lower())
    if not assets:
        return h.json_out({"message": "Способ оплаты недоступен"}, 400)
    price = float(prod.get("price") or 0)
    promo_code, discount = None, 0
    if str(body.get("promoCode") or "").strip():
        p, err = promo_lookup(body.get("promoCode"), user["id"])
        if not p:
            return h.json_out({"message": err or "Промокод не найден"}, 400)
        promo_code, discount = p["code"], int(p["discount"])
    amount = max(1, int(price * (100 - discount) / 100 + 0.5)) if discount else int(price)
    order_id = "SNW-" + secrets.token_hex(6).upper()
    params = {
        "currency_type": "fiat", "fiat": "RUB", "amount": str(amount),
        "accepted_assets": assets, "description": prod["title"][:200],
        "payload": order_id, "expires_in": 3600, "allow_comments": False,
    }
    if SITE_URL:
        params.update({"paid_btn_name": "callback", "paid_btn_url": SITE_URL + "/cabinet"})
    if "testnet" in CRYPTO_API:
        params.pop("accepted_assets", None)  # в тестовой сети другой набор монет
    try:
        inv = crypto_call("createInvoice", params, post=True)
    except Exception:
        traceback.print_exc()
        return h.json_out({"message": "Не удалось создать счёт, попробуйте позже или купите через FunPay"}, 502)
    method = str(body.get("method") or "cryptobot").strip().lower()
    # конкретная монета — страница оплаты в браузере; «Crypto Bot» — ссылка в Telegram
    if method == "cryptobot":
        pay_url = inv.get("bot_invoice_url") or inv.get("web_app_invoice_url") or inv.get("pay_url")
    else:
        pay_url = inv.get("web_app_invoice_url") or inv.get("bot_invoice_url") or inv.get("pay_url")
    _db("INSERT INTO payments(order_id,user_id,product_id,amount,promo,invoice_id,created_at) VALUES(?,?,?,?,?,?,?)",
        (order_id, user["id"], int(prod["id"]), amount, promo_code, inv["invoice_id"], now_iso()))
    return h.json_out({"success": True, "orderId": order_id, "amount": amount,
                       "payUrl": pay_url})


@proute("GET", r"^/api/payments/([A-Za-z0-9-]{1,40})$")
def payments_status(h, mo, body, user):
    if not require(user):
        return h.json_out({"message": "Не авторизован"}, 401)
    row = _db1("SELECT * FROM payments WHERE order_id=? AND user_id=?", (mo.group(1), user["id"]))
    if not row:
        return h.json_out({"message": "Заказ не найден"}, 404)
    status = row["status"]
    if status == "pending":
        try:
            res = crypto_call("getInvoices", {"invoice_ids": str(row["invoice_id"])})
            items = res.get("items", []) if isinstance(res, dict) else res
            st = items[0]["status"] if items else "active"
            if st == "paid":
                settle_payment(row["order_id"])
                status = "paid"
            elif st == "expired":
                _db("UPDATE payments SET status='expired' WHERE order_id=? AND status='pending'", (row["order_id"],))
                status = "expired"
        except Exception:
            traceback.print_exc()
    return h.json_out({"success": True, "status": status, "paid": status == "paid"})


@route("POST", "/api/orders/check-promo")
def check_promo(h, body, user):
    k = "promo:" + h.client_ip()
    if throttled(k, 30, 600):
        return h.json_out({"message": "Слишком много попыток"}, 429)
    p, err = promo_lookup(body.get("code"), user["id"] if user else None)
    if not p:
        note_fail(k)
        return h.json_out({"success": True, "valid": False, "discount": 0, "message": err or "Промокод не найден"})
    d = int(p["discount"])
    return h.json_out({"success": True, "valid": True, "discount": d, "data": {"valid": True, "discount": d}})


@route("GET", "/api/users/products")
def users_products(h, body, user):
    if not require(user):
        return h.json_out({"message": "Не авторизован"}, 401)
    rows = _db("SELECT * FROM purchases WHERE user_id=? ORDER BY purchased_at DESC", (user["id"],))
    out = [
        {
            "id": r["id"],
            "product_id": r["product_id"],
            "title": r["title"],
            "price": r["price"],
            "source": r["source"],
            "purchased_at": r["purchased_at"],
            "expires_at": r["expires_at"],
        }
        for r in rows
    ]
    return h.json_out({"success": True, "data": out, "count": len(out)})


@route("POST", "/api/presence/web/heartbeat")
def presence_hb(h, body, user):
    return h.json_out({"success": True, "online": True})


@route("POST", "/api/presence/web/offline")
def presence_off(h, body, user):
    return h.json_out({"success": True})


@proute("GET", r"^/api/presence/")
def presence_get(h, mo, body, user):
    d = {"status": "online", "online": True, "mode": "online"}
    return h.json_out({"success": True, "data": dict(d), **d})


@proute("GET", r"^/api/tokens/")
def tokens_get(h, mo, body, user):
    return h.json_out({"success": False, "message": "Используйте /api/loader/download"})


@proute("GET", r"^/api/freeze/")
def freeze_get(h, mo, body, user):
    d = {"active": False, "frozen": False, "until": None}
    return h.json_out({"success": True, "data": dict(d), **d})


# ---- admin panel API

def is_admin_role(user):
    return user is not None and user["role"] == "admin"


def require_admin(user):
    return (
        is_admin_role(user)
        and bool(user["totp_enabled"])
        and time.time() - user["_mfa_at"] < ADMIN_MFA_TTL
    )


def num(v):
    f = float(v or 0)
    if not math.isfinite(f) or abs(f) > 1e9:
        raise ValueError("bad number")
    return f


@route("GET", "/api/admin/users")
def admin_users(h, body, user):
    if not require_admin(user):
        return h.json_out({"message": "Доступ только для админа"}, 403)
    rows = _db(
        "SELECT u.*, COALESCE(p.c, 0) AS purchases_cnt, COALESCE(i.c, 0) AS cosmetics_cnt"
        " FROM users u"
        " LEFT JOIN (SELECT user_id, COUNT(*) c FROM purchases GROUP BY user_id) p ON p.user_id = u.id"
        " LEFT JOIN (SELECT user_id, COUNT(*) c FROM inventory GROUP BY user_id) i ON i.user_id = u.id"
        " ORDER BY u.id"
    )
    out = []
    for r in rows:
        out.append({
            "id": r["id"],
            "username": r["username"],
            "email": r["email"],
            "display_name": r["display_name"],
            "role": r["role"],
            "balance": r["balance"],
            "total_deposits": r["total_deposits"],
            "total_purchases": r["total_purchases"],
            "hwid": r.get("hwid") or "",
            "hwid_bound_at": r.get("hwid_bound_at") or "",
            "created_at": r["created_at"],
            "banned": bool(r["banned"]),
            "purchases": r["purchases_cnt"],
            "cosmetics": r["cosmetics_cnt"],
        })
    return h.json_out({"success": True, "data": out, "count": len(out)})

@route("POST", "/api/admin/users/update")
def admin_update(h, body, user):
    if not require_admin(user):
        return h.json_out({"message": "Доступ только для админа"}, 403)
    uid = body.get("userId")
    target = get_user_by_id(uid)
    if not target:
        return h.json_out({"message": "Пользователь не найден"}, 404)
    if target["role"] == "admin" and target["id"] != user["id"]:
        return h.json_out({"message": "Другого админа менять нельзя"}, 403)
    audit(user, "update_user", "user=%s fields=%s" % (uid, ",".join(k for k in body if k != "password" and k != "userId")) + (",password" if body.get("password") else ""))
    if body.get("reset_hwid"):
        reset_user_hwid(target["id"])
    if "role" in body:
        role = str(body.get("role"))
        if role not in ("user", "beta_tester", "moderator", "admin"):
            return h.json_out({"message": "Неизвестная роль"}, 400)
        if target["id"] == user["id"] and role != "admin":
            return h.json_out({"message": "Нельзя снять админку с самого себя"}, 400)
        _db("UPDATE users SET role=? WHERE id=?", (role, uid))
    if "balance" in body:
        try:
            val = num(body.get("balance"))
        except (TypeError, ValueError):
            return h.json_out({"message": "Некорректный баланс"}, 400)
        _db("UPDATE users SET balance=? WHERE id=?", (val, uid))
    if "password" in body and body.get("password"):
        if len(str(body["password"])) < 8:
            return h.json_out({"message": "Пароль минимум 8 символов"}, 400)
        _db("UPDATE users SET pass_hash=? WHERE id=?", (hash_password(str(body["password"])), uid))
        _db("DELETE FROM tokens WHERE user_id=? AND token<>?", (uid, user.get("_token")))
    if "username" in body and body.get("username"):
        val = str(body["username"]).strip()
        if not re.fullmatch(r"[A-Za-z0-9_]{3,20}", val):
            return h.json_out({"message": "Ник: 3-20 символов (латиница, цифры, _)"}, 400)
        if _db1("SELECT id FROM users WHERE lower(username)=lower(?) AND id<>?", (val, uid)):
            return h.json_out({"message": "Ник занят"}, 400)
        _db("UPDATE users SET username=? WHERE id=?", (val, uid))
    if "email" in body and body.get("email"):
        val = str(body["email"]).strip().lower()
        if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", val):
            return h.json_out({"message": "Некорректный email"}, 400)
        if _db1("SELECT id FROM users WHERE lower(email)=lower(?) AND id<>?", (val, uid)):
            return h.json_out({"message": "Email занят"}, 400)
        _db("UPDATE users SET email=? WHERE id=?", (val, uid))
    u = get_user_by_id(uid)
    return h.json_out({"success": True, "data": user_json(u), "user": user_json(u)})


@route("POST", "/api/admin/users/grant")
def admin_grant(h, body, user):
    if not require_admin(user):
        return h.json_out({"message": "Доступ только для админа"}, 403)
    uid = body.get("userId")
    target = get_user_by_id(uid)
    if not target:
        return h.json_out({"message": "Пользователь не найден"}, 404)
    if "amount" in body:
        try:
            amt = num(body.get("amount"))
        except (TypeError, ValueError):
            return h.json_out({"message": "Некорректная сумма"}, 400)
        audit(user, "grant_balance", "user=%s amount=%s" % (uid, amt))
        _db("UPDATE users SET balance=balance+?, total_deposits=total_deposits+? WHERE id=?", (amt, amt, uid))
        u = get_user_by_id(uid)
        return h.json_out({"success": True, "message": "Начислено %.2f ₽" % amt, "data": user_json(u)})
    if "productId" in body:
        prod = find_product(body.get("productId"))
        if not prod:
            return h.json_out({"message": "Товар не найден"}, 400)
        audit(user, "grant_product", "user=%s product=%s" % (uid, prod.get("id")))
        grant_product(target["id"], prod, "admin")
        msg = "HWID сброшен" if is_hwid_reset(prod) else "Выдан: %s" % prod.get("title")
        return h.json_out({"success": True, "message": msg})
    if "cosmeticId" in body:
        try:
            cid = int(body.get("cosmeticId"))
        except (TypeError, ValueError):
            return h.json_out({"message": "Некорректная косметика"}, 400)
        audit(user, "grant_cosmetic", "user=%s cosmetic=%s" % (uid, cid))
        if not _db1("SELECT 1 FROM inventory WHERE user_id=? AND cosmetic_id=?", (uid, cid)):
            _db(
                "INSERT INTO inventory(user_id,cosmetic_id,active,granted_at) VALUES(?,?,0,?)",
                (target["id"], cid, now_iso()),
            )
        return h.json_out({"success": True, "message": "Косметика #%d выдана" % cid})
    return h.json_out({"message": "Нечего выдавать"}, 400)
@route("GET", "/api/admin/users/subscriptions")
def admin_user_subs(h, body, user):
    if not require_admin(user):
        return h.json_out({"message": "Доступ только для админа"}, 403)
    uid = h.path.split("userId=")[-1].split("&")[0] if "userId=" in h.path else ""
    try:
        uid = int(uid)
    except (TypeError, ValueError):
        return h.json_out({"message": "Некорректный userId"}, 400)
    rows = _db(
        "SELECT id, product_id, title, price, source, purchased_at, expires_at"
        " FROM purchases WHERE user_id=? ORDER BY id DESC",
        (uid,),
    )
    inv = _db("SELECT cosmetic_id, active, granted_at FROM inventory WHERE user_id=? ORDER BY granted_at DESC", (uid,))
    return h.json_out({"success": True, "subscriptions": rows, "cosmetics": inv})


@route("POST", "/api/admin/subscriptions/update")
def admin_sub_update(h, body, user):
    if not require_admin(user):
        return h.json_out({"message": "Доступ только для админа"}, 403)
    try:
        sub_id = int(body.get("id"))
    except (TypeError, ValueError):
        return h.json_out({"message": "Некорректный ID подписки"}, 400)
    row = _db1("SELECT * FROM purchases WHERE id=?", (sub_id,))
    if not row:
        return h.json_out({"message": "Подписка не найдена"}, 404)

    action = str(body.get("action") or "")
    if action == "delete":
        _db("DELETE FROM purchases WHERE id=?", (sub_id,))
        audit(user, "delete_subscription", "sub=%s user=%s title=%s" % (sub_id, row["user_id"], row["title"]))
        return h.json_out({"success": True, "message": "Подписка удалена"})

    if action == "lifetime":
        _db("UPDATE purchases SET expires_at=NULL WHERE id=?", (sub_id,))
        audit(user, "lifetime_subscription", "sub=%s user=%s" % (sub_id, row["user_id"]))
        return h.json_out({"success": True, "message": "Выдан Lifetime"})

    if action == "extend":
        try:
            days = int(body.get("days") or 0)
        except (TypeError, ValueError):
            return h.json_out({"message": "Некорректное число дней"}, 400)
        if days == 0 or abs(days) > 3650:
            return h.json_out({"message": "Укажите от -3650 до 3650 дней"}, 400)
        cur_exp = row.get("expires_at")
        base_ts = time.time()
        if cur_exp:
            try:
                parsed = calendar.timegm(time.strptime(cur_exp[:19], "%Y-%m-%dT%H:%M:%S"))
                if parsed > base_ts:
                    base_ts = parsed
            except ValueError:
                pass
        new_exp = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(base_ts + days * 86400)) + ".000Z"
        _db("UPDATE purchases SET expires_at=? WHERE id=?", (new_exp, sub_id))
        audit(user, "extend_subscription", "sub=%s user=%s days=%s" % (sub_id, row["user_id"], days))
        return h.json_out({"success": True, "message": "Срок обновлён"})

    if action == "set_date":
        raw_date = str(body.get("expires_at") or "").strip()
        if not raw_date:
            _db("UPDATE purchases SET expires_at=NULL WHERE id=?", (sub_id,))
        else:
            if len(raw_date) == 10:
                raw_date += "T23:59:59.000Z"
            elif len(raw_date) == 16:
                raw_date += ":00.000Z"
            _db("UPDATE purchases SET expires_at=? WHERE id=?", (raw_date, sub_id))
        audit(user, "set_sub_date", "sub=%s user=%s date=%s" % (sub_id, row["user_id"], raw_date or "lifetime"))
        return h.json_out({"success": True, "message": "Дата окончания изменена"})

    return h.json_out({"message": "Неизвестное действие"}, 400)


@route("POST", "/api/admin/cosmetics/delete")
def admin_cos_delete(h, body, user):
    if not require_admin(user):
        return h.json_out({"message": "Доступ только для админа"}, 403)
    try:
        uid = int(body.get("userId"))
        cid = int(body.get("cosmeticId"))
    except (TypeError, ValueError):
        return h.json_out({"message": "Некорректные параметры"}, 400)
    _db("DELETE FROM inventory WHERE user_id=? AND cosmetic_id=?", (uid, cid))
    audit(user, "delete_cosmetic", "user=%s cosmetic=%s" % (uid, cid))
    return h.json_out({"success": True, "message": "Косметика изъята"})

@route("POST", "/api/admin/keys")
def admin_keys(h, body, user):
    if not require_admin(user):
        return h.json_out({"message": "Доступ только для админа"}, 403)
    prod = find_product(body.get("productId"))
    if not prod:
        return h.json_out({"message": "Товар не найден"}, 400)
    pid = int(prod["id"])
    try:
        count = max(1, min(int(body.get("count") or 1), 100))
    except (TypeError, ValueError):
        count = 1
    made = []
    custom = str(body.get("key") or "").strip().upper()
    if count == 1 and custom and not re.fullmatch(r"[A-Z0-9][A-Z0-9-]{11,63}", custom):
        return h.json_out({"message": "Свой ключ: 12–64 символа, A-Z, 0-9 и «-»"}, 400)
    audit(user, "create_keys", "product=%s count=%s" % (pid, count))
    for _ in range(count):
        key = (custom if count == 1 else "") or (
            "SNW-" + "-".join(secrets.token_hex(2).upper() for _ in range(3))
        )
        if _db1("SELECT 1 FROM keys WHERE key=?", (key,)):
            if count == 1:
                return h.json_out({"message": "Ключ уже существует"}, 400)
            continue
        _db(
            "INSERT INTO keys(key,product_id,created_by,created_at) VALUES(?,?,?,?)",
            (key, pid, user["id"], now_iso()),
        )
        made.append(key)
    return h.json_out({"success": True, "key": made[0] if made else None, "keys": made, "data": {"keys": made}})


@route("POST", "/api/admin/keys/delete")
def admin_keys_delete(h, body, user):
    if not require_admin(user):
        return h.json_out({"message": "Доступ только для админа"}, 403)
    audit(user, "delete_key", body.get("key"))
    _db("DELETE FROM keys WHERE key=? AND used_by IS NULL", (str(body.get("key") or ""),))
    return h.json_out({"success": True})


@route("POST", "/api/admin/users/delete")
def admin_user_delete(h, body, user):
    if not require_admin(user):
        return h.json_out({"message": "Доступ только для админа"}, 403)
    try:
        uid = int(body.get("userId"))
    except (TypeError, ValueError):
        return h.json_out({"message": "Некорректный пользователь"}, 400)
    if uid == user["id"]:
        return h.json_out({"message": "Нельзя удалить самого себя"}, 400)
    t = get_user_by_id(uid)
    if t and t["role"] == "admin":
        return h.json_out({"message": "Админа удалить нельзя"}, 403)
    audit(user, "delete_user", "user=%s name=%s" % (uid, t and t["username"]))
    for tbl in ("tokens", "inventory", "purchases"):
        _db("DELETE FROM %s WHERE user_id=?" % tbl, (uid,))
    _db("DELETE FROM users WHERE id=?", (uid,))
    return h.json_out({"success": True})


@route("GET", "/api/admin/promos")
def admin_promos(h, body, user):
    if not require_admin(user):
        return h.json_out({"message": "Доступ только для админа"}, 403)
    rows = _db("SELECT p.*, COALESCE((SELECT SUM(amount) FROM promo_uses WHERE code=p.code),0) AS revenue"
               " FROM promocodes p ORDER BY created_at DESC")
    return h.json_out({"success": True, "data": [dict(r) for r in rows]})


@route("POST", "/api/admin/promos")
def admin_promo_create(h, body, user):
    if not require_admin(user):
        return h.json_out({"message": "Доступ только для админа"}, 403)
    code = str(body.get("code") or "").strip().upper()
    if not code:
        code = "SNOW" + secrets.token_hex(3).upper()
    if not re.fullmatch(r"[A-Z0-9_-]{3,32}", code):
        return h.json_out({"message": "Код: 3–32 символа, A-Z, 0-9, «_» и «-»"}, 400)
    try:
        disc = int(body.get("discount") or 0)
        max_uses = max(0, int(body.get("maxUses") or 0))
        days = max(0, int(body.get("days") or 0))
    except (TypeError, ValueError):
        return h.json_out({"message": "Некорректные числа"}, 400)
    if not 1 <= disc <= 99:
        return h.json_out({"message": "Скидка: от 1 до 99%"}, 400)
    exp = (time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(time.time() + days * 86400)) + ".000Z") if days else None
    if _db1("SELECT 1 FROM promocodes WHERE code=?", (code,)):
        return h.json_out({"message": "Такой промокод уже есть"}, 400)
    _db("INSERT INTO promocodes(code,discount,max_uses,expires_at,created_at) VALUES(?,?,?,?,?)",
        (code, disc, max_uses, exp, now_iso()))
    audit(user, "create_promo", "%s -%s%% max=%s days=%s" % (code, disc, max_uses, days))
    return h.json_out({"success": True, "code": code})


@route("POST", "/api/admin/promos/update")
def admin_promo_update(h, body, user):
    if not require_admin(user):
        return h.json_out({"message": "Доступ только для админа"}, 403)
    code = str(body.get("code") or "").strip().upper()
    act = body.get("action")
    if act == "toggle":
        _db("UPDATE promocodes SET active = 1 - active WHERE code=?", (code,))
    elif act == "delete":
        _db("DELETE FROM promocodes WHERE code=?", (code,))
    else:
        return h.json_out({"message": "Неизвестное действие"}, 400)
    audit(user, "promo_" + act, code)
    return h.json_out({"success": True})


@route("POST", "/api/admin/promos/uses")
def admin_promo_uses(h, body, user):
    if not require_admin(user):
        return h.json_out({"message": "Доступ только для админа"}, 403)
    rows = _db("SELECT pu.*, u.username FROM promo_uses pu LEFT JOIN users u ON u.id=pu.user_id"
               " WHERE pu.code=? ORDER BY pu.id DESC LIMIT 300", (str(body.get("code") or "").strip().upper(),))
    return h.json_out({"success": True, "data": [dict(r) for r in rows]})


@route("GET", "/api/admin/stats")
def admin_stats(h, body, user):
    if not require_admin(user):
        return h.json_out({"message": "Доступ только для админа"}, 403)
    r = _db1("SELECT COUNT(*) c, COALESCE(SUM(balance),0) b FROM users")
    roles = {x["role"]: x["c"] for x in _db("SELECT role, COUNT(*) c FROM users GROUP BY role")}
    k = _db1("SELECT COUNT(*) total, COUNT(used_by) used FROM keys")
    p = _db1("SELECT COUNT(*) c FROM purchases")
    week = _db1("SELECT COUNT(*) c FROM users WHERE created_at >= ?", (time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(time.time() - 7 * 86400)),))
    return h.json_out({"success": True, "data": {
        "users": r["c"], "balance": float(r["b"]), "roles": roles,
        "keys_total": k["total"], "keys_used": k["used"], "purchases": p["c"], "new_week": week["c"]}})


@route("GET", "/api/admin/keys")
def admin_keys_list(h, body, user):
    if not require_admin(user):
        return h.json_out({"message": "Доступ только для админа"}, 403)
    rows = _db("SELECT * FROM keys ORDER BY created_at DESC")
    out = []
    for r in rows:
        prod = find_product(r["product_id"]) or {}
        out.append(
            {
                "key": r["key"],
                "product_id": r["product_id"],
                "product_title": prod.get("title") or ("Подписка #%s" % r["product_id"]),
                "used_by": r["used_by"],
                "used_at": r["used_at"],
                "created_at": r["created_at"],
            }
        )
    return h.json_out({"success": True, "data": out, "count": len(out)})


# ---------------------------------------------------------------- security / 2FA

_fails = {}
_fl = threading.Lock()


def throttled(key, limit=5, window=900):
    now = time.time()
    with _fl:
        _fails[key] = [t for t in _fails.get(key, []) if now - t < window]
        return len(_fails[key]) >= limit


def note_fail(key):
    with _fl:
        _fails.setdefault(key, []).append(time.time())
        if len(_fails) > 20000:
            # выкидываем только пустые/старые записи; счётчики 2FA и свежие блокировки не трогаем
            cutoff = time.time() - 3600
            for k in [k for k, v in _fails.items() if not v or v[-1] < cutoff]:
                del _fails[k]
            if len(_fails) > 20000:
                old = sorted((k for k in _fails if not k.startswith("mfa:")), key=lambda k: _fails[k][-1])
                for k in old[:5000]:
                    del _fails[k]


def migrate():
    for col in (
        "banned INTEGER NOT NULL DEFAULT 0",
        "totp_secret TEXT",
        "totp_enabled INTEGER NOT NULL DEFAULT 0",
        "totp_last BIGINT NOT NULL DEFAULT 0",
        "backup_codes TEXT NOT NULL DEFAULT ''",
        "hwid TEXT NOT NULL DEFAULT ''",
        "hwid_bound_at TEXT NOT NULL DEFAULT ''",
        "referred_by INTEGER",
        "ref_paid INTEGER NOT NULL DEFAULT 0",
        "terms_accepted_at TEXT NOT NULL DEFAULT ''",
        "terms_version TEXT NOT NULL DEFAULT ''",
        "launch_count INTEGER NOT NULL DEFAULT 0",
        "last_launch_at TEXT NOT NULL DEFAULT ''",
    ):
        _run("ALTER TABLE users ADD COLUMN IF NOT EXISTS " + col, (), False)
    _run("ALTER TABLE tokens ADD COLUMN IF NOT EXISTS mfa_at DOUBLE PRECISION NOT NULL DEFAULT 0", (), False)
    _run("ALTER TABLE tokens ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'web'", (), False)
    _run("CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT)", (), False)
    # однократно: старые токены лежали в БД открытым текстом — сбрасываем все сессии
    if not _db1("SELECT 1 FROM meta WHERE k='tokens_hashed'"):
        _run("DELETE FROM tokens", (), False)
        _run("INSERT INTO meta(k,v) VALUES('tokens_hashed','1')", (), False)
    # раньше покупка «Сброс HWID» (expires_at=NULL) выдавала Lifetime — гасим такие записи
    _run("UPDATE purchases SET expires_at='1970-01-01T00:00:00.000Z' WHERE product_id=5 AND expires_at IS NULL", (), False)
    for ddl in (
        "CREATE INDEX IF NOT EXISTS tokens_user ON tokens(user_id)",
        "CREATE INDEX IF NOT EXISTS purchases_user ON purchases(user_id)",
        "CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower ON users(lower(username))",
        "CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower ON users(lower(email))",
    ):
        try:
            _run(ddl, (), False)
        except Exception as e:  # например, уже есть дубли ников — разберите вручную
            print("migrate warning:", ddl, "->", e, file=sys.stderr)
    _run(
        "CREATE TABLE IF NOT EXISTS audit(id SERIAL PRIMARY KEY, ts TEXT NOT NULL, admin_id INTEGER,"
        " admin_name TEXT, action TEXT NOT NULL, detail TEXT)", (), False)
    for col in (
        "ts TEXT",
        "admin_id INTEGER",
        "admin_name TEXT",
        "action TEXT",
        "detail TEXT",
    ):
        _run("ALTER TABLE audit ADD COLUMN IF NOT EXISTS " + col, (), False)
    for r in _db(
        "SELECT column_name FROM information_schema.columns"
        " WHERE table_schema = current_schema() AND table_name = 'audit'"
        " AND is_nullable = 'NO' AND column_name NOT IN ('id', 'ts', 'action')"
    ):
        _run("ALTER TABLE audit ALTER COLUMN %s DROP NOT NULL" % r["column_name"], (), False)
    for col in (
        "product_id INTEGER",
        "created_by INTEGER",
        "used_by INTEGER",
        "used_at TEXT",
        "created_at TEXT",
    ):
        _run("ALTER TABLE keys ADD COLUMN IF NOT EXISTS " + col, (), False)
    for r in _db(
        "SELECT column_name FROM information_schema.columns"
        " WHERE table_schema = current_schema() AND table_name = 'keys'"
        " AND is_nullable = 'NO' AND column_name NOT IN ('key', 'product_id', 'created_at')"
    ):
        _run("ALTER TABLE keys ALTER COLUMN %s DROP NOT NULL" % r["column_name"], (), False)
    _run("""CREATE TABLE IF NOT EXISTS payments(
        order_id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, product_id INTEGER NOT NULL,
        amount DOUBLE PRECISION NOT NULL, promo TEXT, invoice_id BIGINT,
        status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, paid_at TEXT)""", (), False)
    _run("""CREATE TABLE IF NOT EXISTS promocodes(
        code TEXT PRIMARY KEY, discount INTEGER NOT NULL, max_uses INTEGER NOT NULL DEFAULT 0,
        uses INTEGER NOT NULL DEFAULT 0, expires_at TEXT, active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL)""", (), False)
    _run("""CREATE TABLE IF NOT EXISTS promo_uses(
        id SERIAL PRIMARY KEY, code TEXT NOT NULL, user_id INTEGER NOT NULL, order_id TEXT,
        discount INTEGER NOT NULL DEFAULT 0, amount DOUBLE PRECISION NOT NULL DEFAULT 0, used_at TEXT NOT NULL)""", (), False)


def audit(admin, action, detail=""):
    _db(
        "INSERT INTO audit(ts,admin_id,admin_name,action,detail) VALUES(?,?,?,?,?)",
        (now_iso(), admin["id"], admin["username"], action, str(detail)[:500]),
    )


def _hotp(secret, counter):
    key = base64.b32decode(secret)
    d = hmac.new(key, struct.pack(">Q", counter), "sha1").digest()
    o = d[-1] & 15
    return "%06d" % ((struct.unpack(">I", d[o:o + 4])[0] & 0x7FFFFFFF) % 1000000)


def check_totp(u, code):
    code = re.sub(r"\s", "", str(code or ""))
    if not u["totp_secret"] or not re.fullmatch(r"\d{6}", code):
        return False
    base = int(time.time() // 30)
    for c in (base - 1, base, base + 1):
        if secrets.compare_digest(_hotp(u["totp_secret"], c), code):
            return bool(_db1("UPDATE users SET totp_last=? WHERE id=? AND totp_last<? RETURNING id", (c, u["id"], c)))
    return False


def _bh(code):
    return hashlib.sha256(code.strip().lower().encode()).hexdigest()


def check_backup(u, code):
    hs = [x for x in (u["backup_codes"] or "").split(",") if x]
    hc = _bh(str(code or ""))
    if hc not in hs:
        return False
    hs.remove(hc)
    return bool(_db1("UPDATE users SET backup_codes=? WHERE id=? AND backup_codes=? RETURNING id",
                     (",".join(hs), u["id"], u["backup_codes"])))


def _mfa_guard(h, user):
    if not is_admin_role(user):
        h.json_out({"message": "Доступ только для админа"}, 403)
        return True
    if throttled("mfa:%s" % user["id"], 5, 600):
        h.json_out({"message": "Слишком много неверных кодов. Подождите 10 минут"}, 429)
        return True
    return False


def _mark_mfa(user):
    _db("UPDATE tokens SET mfa_at=? WHERE token=?", (time.time(), user["_token"]))


@route("GET", "/api/admin/2fa/status")
def mfa_status(h, body, user):
    if not is_admin_role(user):
        return h.json_out({"message": "Доступ только для админа"}, 403)
    h.json_out({"success": True, "enabled": bool(user["totp_enabled"]), "verified": require_admin(user)})


@route("POST", "/api/admin/2fa/setup")
def mfa_setup(h, body, user):
    if _mfa_guard(h, user):
        return
    if user["totp_enabled"]:
        return h.json_out({"message": "2FA уже включена. Сначала отключите её"}, 400)
    if not check_password(str(body.get("password") or ""), user["pass_hash"]):
        note_fail("mfa:%s" % user["id"])
        return h.json_out({"message": "Неверный пароль"}, 400)
    secret = user["totp_secret"] or base64.b32encode(os.urandom(20)).decode()
    if not user["totp_secret"]:
        _db("UPDATE users SET totp_secret=? WHERE id=?", (secret, user["id"]))
    uri = "otpauth://totp/Admin:%s?secret=%s&issuer=Admin&period=30&digits=6" % (user["username"], secret)
    h.json_out({"success": True, "secret": secret, "uri": uri})

@route("POST", "/api/admin/2fa/enable")
def mfa_enable(h, body, user):
    if _mfa_guard(h, user):
        return
    if user["totp_enabled"] or not user["totp_secret"]:
        return h.json_out({"message": "Сначала запросите секрет (setup)"}, 400)
    if not check_totp(user, body.get("code")):
        note_fail("mfa:%s" % user["id"])
        return h.json_out({"message": "Неверный код"}, 400)
    codes = ["%s-%s" % (secrets.token_hex(3), secrets.token_hex(3)) for _ in range(8)]
    _db("UPDATE users SET totp_enabled=1, backup_codes=? WHERE id=?", (",".join(_bh(c) for c in codes), user["id"]))
    _mark_mfa(user)
    audit(user, "2fa_enable")
    h.json_out({"success": True, "backup_codes": codes})


@route("POST", "/api/admin/2fa/verify")
def mfa_verify(h, body, user):
    if _mfa_guard(h, user):
        return
    if not user["totp_enabled"]:
        return h.json_out({"message": "2FA не настроена"}, 400)
    code = str(body.get("code") or "")
    if not (check_totp(user, code) or check_backup(user, code)):
        note_fail("mfa:%s" % user["id"])
        return h.json_out({"message": "Неверный код"}, 400)
    _mark_mfa(user)
    audit(user, "login_2fa", h.client_ip())
    h.json_out({"success": True})


@route("POST", "/api/admin/2fa/disable")
def mfa_disable(h, body, user):
    if not require_admin(user):
        return h.json_out({"message": "Нужно подтверждение 2FA"}, 403)
    if _mfa_guard(h, user):
        return
    if not check_password(str(body.get("password") or ""), user["pass_hash"]) or not check_totp(user, body.get("code")):
        note_fail("mfa:%s" % user["id"])
        return h.json_out({"message": "Неверный пароль или код"}, 400)
    _db("UPDATE users SET totp_enabled=0, totp_secret=NULL, backup_codes='' WHERE id=?", (user["id"],))
    audit(user, "2fa_disable")
    h.json_out({"success": True})


@route("GET", "/api/admin/products")
def admin_products(h, body, user):
    if not require_admin(user):
        return h.json_out({"message": "Доступ только для админа"}, 403)
    prods = fetch_products()
    out = [{"id": p.get("id"), "title": p.get("title"), "price": p.get("price"), "type": p.get("type") or ""} for p in prods]
    if not out:
        out = [
            {"id": 1, "title": "SnowClient — 1 Месяц", "price": 299},
            {"id": 2, "title": "SnowClient — 3 Месяца", "price": 699},
            {"id": 3, "title": "SnowClient — 6 Месяцев", "price": 1199},
            {"id": 4, "title": "SnowClient — Lifetime", "price": 2499},
        ]
    h.json_out({"success": True, "data": out})


@route("GET", "/api/admin/purchases")
def admin_purchases(h, body, user):
    if not require_admin(user):
        return h.json_out({"message": "Доступ только для админа"}, 403)
    rows = _db(
        "SELECT p.id,p.title,p.price,p.source,p.purchased_at,p.expires_at,u.username FROM purchases p"
        " LEFT JOIN users u ON u.id=p.user_id ORDER BY p.id DESC LIMIT 300"
    )
    h.json_out({"success": True, "data": rows})


@route("GET", "/api/admin/audit")
def admin_audit(h, body, user):
    if not require_admin(user):
        return h.json_out({"message": "Доступ только для админа"}, 403)
    h.json_out({"success": True, "data": _db("SELECT * FROM audit ORDER BY id DESC LIMIT 300")})


@route("POST", "/api/admin/users/ban")
def admin_ban(h, body, user):
    if not require_admin(user):
        return h.json_out({"message": "Доступ только для админа"}, 403)
    t = get_user_by_id(body.get("userId"))
    if not t or t["role"] == "admin":
        return h.json_out({"message": "Пользователь не найден или это админ"}, 400)
    ban = 1 if body.get("banned") else 0
    _db("UPDATE users SET banned=? WHERE id=?", (ban, t["id"]))
    if ban:
        _db("DELETE FROM tokens WHERE user_id=?", (t["id"],))
    audit(user, "ban" if ban else "unban", "user=%s" % t["id"])
    h.json_out({"success": True})


@route("POST", "/api/admin/users/logout")
def admin_kick(h, body, user):
    if not require_admin(user):
        return h.json_out({"message": "Доступ только для админа"}, 403)
    t = get_user_by_id(body.get("userId"))
    if not t or (t["role"] == "admin" and t["id"] != user["id"]):
        return h.json_out({"message": "Нельзя"}, 400)
    _db("DELETE FROM tokens WHERE user_id=? AND token<>?", (t["id"], user["_token"]))
    audit(user, "kick_sessions", "user=%s" % t["id"])
    h.json_out({"success": True})


# ---------------------------------------------------------------- handler


class Handler(http.server.SimpleHTTPRequestHandler):
    timeout = 30  # защита от «медленных» соединений

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def json_out(self, obj, status=200):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    server_version = "web"
    sys_version = ""

    def client_ip(self):
        if TRUST_PROXY:
            xff = (self.headers.get("X-Forwarded-For") or "").split(",")
            if xff[-1].strip():
                return xff[-1].strip()[:64]
        return self.client_address[0]

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Strict-Transport-Security", "max-age=31536000")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        clean_path = self.path.split("?")[0]
        if clean_path in (
            "/admin", "/admin/", "/admin.html", "/admin.js",
            "/cabinet", "/cabinet/", "/cabinet.html", "/cabinet.js",
        ) or self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-store")
        if clean_path in ("/admin", "/admin/", "/admin.html"):
            self.send_header("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
        elif not self.path.startswith("/api/"):
            # inline onclick/onerror в разметке пока требуют 'unsafe-inline' для скриптов
            self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: https:; frame-src https://www.youtube-nocookie.com https://www.youtube.com; connect-src 'self' http://127.0.0.1:*; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")
        super().end_headers()

    def bearer_token(self):
        auth = self.headers.get("Authorization") or ""
        if auth.lower().startswith("bearer "):
            return auth[7:].strip()
        return None

    def read_body(self, path=""):
        """dict / bytes (только загрузка картинок) / None, если запрос некорректен или слишком большой."""
        raw_len = self.headers.get("Content-Length")
        if not raw_len:
            return {}
        try:
            length = int(raw_len)
        except ValueError:
            return None
        ctype = self.headers.get("Content-Type") or ""
        multipart = "multipart/form-data" in ctype
        if length < 0 or length > (MAX_UPLOAD if (multipart and path in UPLOAD_PATHS) else MAX_JSON):
            return None
        raw = self.rfile.read(length) if length else b""
        if multipart:
            return raw if path in UPLOAD_PATHS else None
        if not raw:
            return {}
        try:
            data = json.loads(raw.decode("utf-8"))
            return data if isinstance(data, dict) else {}
        except Exception:
            return {}

    STATIC_OK = ("/static/", "/uploads/local/", "/assets/", "/fonts/")
    STATIC_FILES = (
    "/", "/index.html", "/admin.html", "/admin.js",
    "/cabinet.html", "/cabinet.js", "/client-auth.js", "/smoke-shader.js",
    "/terms.html", "/rules.html", "/privacy.html",
    "/style.css", "/script.js", "/config.js",
    "/favicon.ico", "/manifest.json", "/robots.txt",
)

    BLOCKED_EXT = (".exe", ".py", ".pyc", ".env", ".sql", ".db", ".sqlite", ".pem", ".key", ".log", ".bak", ".txt", ".md")
    STATIC_DIRS = ("static", "uploads/local", "assets", "fonts")

    def _static_target(self, clean):
        """Путь к файлу, который МОЖНО отдать, иначе None.
        Защита: нет '..', нет скрытых файлов, нет выхода за разрешённые папки (realpath),
        закрытые расширения (.exe отдаётся только через /api/loader/download)."""
        rel = unquote(clean)
        if "\x00" in rel or "\\" in rel or not rel.startswith("/"):
            return None
        parts = [p for p in rel.split("/") if p]
        if any(p in (".", "..") or p.startswith(".") for p in parts):
            return None
        real_root = os.path.realpath(ROOT)
        fs = os.path.realpath(os.path.join(real_root, *parts))
        if rel in self.STATIC_FILES:
            ok = fs == os.path.join(real_root, *parts)
        else:
            ok = any(
                rel.startswith("/" + d + "/") and fs.startswith(os.path.join(real_root, *d.split("/")) + os.sep)
                for d in self.STATIC_DIRS
            )
        if not ok or not os.path.isfile(fs):
            return None
        if rel not in self.STATIC_FILES and fs.lower().endswith(self.BLOCKED_EXT):
            return None
        return fs

    def _serve_static(self):
        clean = urlsplit(self.path).path
        if clean == "/":
            clean = "/index.html"
        if self._static_target(clean):
            self.path = clean
            return super().do_GET()
        if "." in os.path.basename(clean):
            return self.send_error(404)
        self.path = "/index.html"
        return super().do_GET()

    def _handle_api(self, method, path, body, user):
        fn = ROUTES.get((method, path))
        if fn:
            fn(self, body, user)
            return
        for m, rx, f in PREFIX_ROUTES:
            if m == method:
                mo = rx.match(path)
                if mo:
                    f(self, mo, body, user)
                    return
        self.json_out({"message": "Не найдено"}, 404)

    def _handle(self, method):
        try:
            self._handle_inner(method)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            traceback.print_exc()  # подробности только в лог, клиенту — ничего лишнего
            try:
                self.json_out({"message": "Внутренняя ошибка сервера"}, 500)
            except Exception:
                pass

    def _handle_inner(self, method):
        parts = urlsplit(self.path)
        path = parts.path
        if path.startswith("/uploads/local/"):
            if method != "GET":
                self.send_error(405)
                return
            return self._serve_static()
        if path.startswith("/uploads"):
            return self.send_error(404)
        if not path.startswith("/api"):
            if method != "GET":
                self.send_error(405)
                return
            if path in ("/admin", "/admin/"):
                self.path = "/admin.html"
            elif path in ("/cabinet", "/cabinet/"):
                self.path = "/cabinet.html"
            elif path.rstrip("/") in ("/terms", "/rules", "/privacy"):
                self.path = path.rstrip("/") + ".html"
            return self._serve_static()
        body = self.read_body(path) if method in ("POST", "PUT", "PATCH", "DELETE") else {}
        if body is None:
            return self.json_out({"message": "Некорректный или слишком большой запрос"}, 413)
        user = get_user_by_token(self.bearer_token())
        if user and user.get("_scope") != "web" and (method, path) not in LOADER_ALLOWED:
            return self.json_out({"message": "Токен не подходит для этого метода"}, 403)
        self._handle_api(method, path, body, user)

    def do_GET(self):
        self._handle("GET")

    def do_POST(self):
        self._handle("POST")

    def do_PUT(self):
        self._handle("PUT")

    def do_PATCH(self):
        self._handle("PATCH")

    def do_DELETE(self):
        self._handle("DELETE")

    def do_OPTIONS(self):
        # сайт и API на одном origin — CORS не нужен
        self.send_response(204)
        self.send_header("Allow", "GET,POST,PUT,PATCH,DELETE,OPTIONS")
        self.end_headers()

    def log_message(self, fmt, *args):
        pass


def _purge_loop():
    while True:
        try:
            cutoff = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(time.time() - TOKEN_TTL))
            _db("DELETE FROM tokens WHERE created_at < ?", (cutoff,))
        except Exception:
            traceback.print_exc()
        time.sleep(3600)


if __name__ == "__main__":
    init_db()
    migrate()
    if os.environ.get("ADMIN_USERNAME") and not os.environ.get("ADMIN_EMAIL"):
        print("WARNING: задан ADMIN_USERNAME без ADMIN_EMAIL — автосоздание админа отключено", file=sys.stderr)
    threading.Thread(target=_purge_loop, daemon=True).start()
    _run("ALTER TABLE users ADD COLUMN IF NOT EXISTS last_daily DOUBLE PRECISION NOT NULL DEFAULT 0", (), False)
    with http.server.ThreadingHTTPServer(("0.0.0.0", PORT), Handler) as httpd:
        print("listening on", PORT)
        httpd.serve_forever()