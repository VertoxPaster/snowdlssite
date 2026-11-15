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
import psycopg2.pool
import time
import urllib.error
import urllib.request
from urllib.parse import urlsplit

ROOT = os.path.dirname(os.path.abspath(__file__))
ORIGIN = "https://pulsevisuals.pro"
DATABASE_URL = os.environ["DATABASE_URL"]
PORT = int(os.environ.get("PORT", "8080"))
MAX_BODY = 8 * 1024 * 1024
PROXY_HEADERS = ("Content-Type", "Accept", "Accept-Language")
BRAND_MAP = (
    (b"pulsevisuals.pro", b"t.me/flodzorx"),
    (b"PulseVisuals", b"Snowclient"),
    (b"Pulse ", b"Snowclient "),
    (b'"Pulse"', b'"Snowclient"'),
)

_db_lock = threading.RLock()
_pool = psycopg2.pool.ThreadedConnectionPool(1, 8, DATABASE_URL)


def _run(sql, params=(), want_rows=True):
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
    name = u["display_name"] or u["username"]
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
        "is_blocked": False,
        "isBlocked": False,
        "is_verified": False,
        "created_at": u["created_at"],
        "ref_code": u["ref_code"],
        "ref_uses": u["ref_uses"],
        "ref_earned": u["ref_earned"],
        "presence": {"status": "online", "mode": "online", "online": True},
        "friendship_status": None,
    }


def public_user_json(u):
    d = user_json(u)
    for k in ("email", "balance", "totalDeposits", "totalPurchases", "hwid", "hwid_bound_at"):
        d.pop(k, None)
    return d


def get_user_by_id(uid):
    return _db1("SELECT * FROM users WHERE id=?", (uid,))


TOKEN_TTL = 30 * 86400
ADMIN_MFA_TTL = 8 * 3600


def get_user_by_token(token):
    if not token:
        return None
    row = _db1("SELECT user_id,created_at,mfa_at FROM tokens WHERE token=?", (token,))
    if not row:
        return None
    try:
        born = calendar.timegm(time.strptime(row["created_at"][:19], "%Y-%m-%dT%H:%M:%S"))
    except ValueError:
        born = 0
    if time.time() - born > TOKEN_TTL:
        _db("DELETE FROM tokens WHERE token=?", (token,))
        return None
    u = get_user_by_id(row["user_id"])
    if not u or u["banned"]:
        return None
    u = dict(u)
    u["_token"], u["_mfa_at"] = token, float(row["mfa_at"] or 0)
    return u


_products_cache = {"t": 0, "data": None}
_cosmetics_cache = {"t": 0, "data": None}


def fetch_products():
    return [
        {"id": 1, "title": "SnowClient — 1 Месяц", "price": 299, "duration": 30},
        {"id": 2, "title": "SnowClient — 3 Месяца", "price": 699, "duration": 90},
        {"id": 3, "title": "SnowClient — 6 Месяцев", "price": 1199, "duration": 180},
        {"id": 4, "title": "SnowClient — Lifetime", "price": 2499, "duration": None},
    ]


def fetch_cosmetics():
    return []


def find_product(pid):
    for p in fetch_products():
        if int(p.get("id") or 0) == int(pid or 0):
            return p
    return None


def find_cosmetic(cid):
    for c in fetch_cosmetics():
        if int(c.get("id") or 0) == int(cid or 0):
            return c
    return None


def grant_product(user_id, product, source):
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

@route("POST", "/api/launcher/auth")
def launcher_auth(h, body, user):
    if not isinstance(body, dict):
        return h.json_out({"status": "error", "message": "Некорректный формат запроса"}, 400)

    ident = str(body.get("username") or body.get("email") or "").strip()
    password = str(body.get("password") or "")
    hwid = str(body.get("hwid") or "").strip()

    if not ident or not password:
        return h.json_out({"status": "error", "message": "Введите логин и пароль"}, 400)
    if not hwid or len(hwid) < 4 or len(hwid) > 128:
        return h.json_out({"status": "error", "message": "Некорректный HWID устройства"}, 400)

    k_ip = "lnc_ip:" + h.client_ip()
    k_id = "lnc_id:" + ident.lower()
    if throttled(k_ip, 25, 900) or throttled(k_id, 10, 900):
        return h.json_out({"status": "error", "message": "Слишком много попыток. Подождите 15 минут"}, 429)

    u = _db1(
        "SELECT * FROM users WHERE lower(username)=lower(?) OR lower(email)=lower(?)",
        (ident, ident),
    )
    if not u or not check_password(password, u["pass_hash"]):
        note_fail(k_ip)
        note_fail(k_id)
        return h.json_out({"status": "error", "message": "Неверный логин или пароль"}, 401)

    if u["banned"]:
        return h.json_out({"status": "error", "message": "Аккаунт заблокирован"}, 403)

    if not has_active_subscription(u):
        return h.json_out({"status": "error", "message": "Нет активной подписки. Оформите на сайте"}, 403)

    saved_hwid = (u.get("hwid") or "").strip()
    if not saved_hwid:
        _db(
            "UPDATE users SET hwid=?, hwid_bound_at=? WHERE id=?",
            (hwid, now_iso(), u["id"]),
        )
    elif not secrets.compare_digest(saved_hwid, hwid):
        return h.json_out(
            {"status": "error", "message": "Аккаунт привязан к другому ПК (HWID mismatch)"},
            403,
        )

    return h.json_out({
        "status": "ok",
        "username": u["username"],
        "role": u["role"],
    })


@route("GET", "/api/loader/download")
def loader_download(h, body, user):
    if not require(user):
        return h.json_out({"message": "Сначала войдите в аккаунт"}, 401)
    if not has_active_subscription(user):
        return h.json_out({"message": "Для скачивания лоадера нужна активная подписка"}, 403)

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
        "message": "Файл лоадера ещё не загружен на сервер (добавьте static/SnowClient.exe или LOADER_URL)"
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
    if len(password) < 6:
        return h.json_out({"message": "Пароль минимум 6 символов"}, 400)
    if _db1("SELECT id FROM users WHERE lower(username)=lower(?) OR email=?", (username, email)):
        return h.json_out({"message": "Пользователь с таким ником или email уже существует"}, 400)
    if throttled("reg:" + h.client_ip(), 5, 3600):
        return h.json_out({"message": "Слишком много регистраций, попробуйте позже"}, 429)
    note_fail("reg:" + h.client_ip())
    boot = os.environ.get("ADMIN_USERNAME", "").lower()
    role = "admin" if (boot and username.lower() == boot and not _db1("SELECT 1 FROM users WHERE role='admin'")) else "user"
    ref_code = "SNW" + secrets.token_hex(4).upper()
    uid = _db1(
        "INSERT INTO users(username,email,pass_hash,role,ref_code,created_at)"
        " VALUES(?,?,?,?,?,?) RETURNING id",
        (username, email, hash_password(password), role, ref_code, now_iso()),
    )["id"]
    ref = str(body.get("referralCode") or "").strip()
    if ref:
        referrer = _db1("SELECT id FROM users WHERE ref_code=?", (ref,))
        if referrer and referrer["id"] != uid:
            _db(
                "UPDATE users SET balance=balance+25, ref_uses=ref_uses+1, ref_earned=ref_earned+25 WHERE id=?",
                (referrer["id"],),
            )
    token = secrets.token_hex(32)
    _db("INSERT INTO tokens(token,user_id,created_at) VALUES(?,?,?)", (token, uid, now_iso()))
    u = get_user_by_id(uid)
    return h.json_out({"success": True, "token": token, "user": user_json(u), "data": {"token": token, "user": user_json(u)}})


@route("POST", "/api/auth/login")
def auth_login(h, body, user):
    password = str(body.get("password") or "")
    ident = str(body.get("email") or "").strip()
    u = _db1("SELECT * FROM users WHERE lower(email)=lower(?) OR lower(username)=lower(?)", (ident, ident))
    k1, k2 = "ip:" + h.client_ip(), "id:" + ident.lower()
    if throttled(k1, 20) or throttled(k2, 5):
        return h.json_out({"message": "Слишком много попыток. Подождите 15 минут"}, 429)
    if not u or not check_password(password, u["pass_hash"]):
        note_fail(k1)
        note_fail(k2)
        return h.json_out({"message": "Неверный email или пароль"}, 401)
    if u["banned"]:
        return h.json_out({"message": "Аккаунт заблокирован"}, 403)
    if not u["pass_hash"].startswith("i"):
        _db("UPDATE users SET pass_hash=? WHERE id=?", (hash_password(password), u["id"]))
    token = secrets.token_hex(32)
    _db("INSERT INTO tokens(token,user_id,created_at) VALUES(?,?,?)", (token, u["id"], now_iso()))
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
        _db("DELETE FROM tokens WHERE token=?", (token,))
    return h.json_out({"success": True})


@route("PUT", "/api/auth/password")
def auth_password(h, body, user):
    if not require(user):
        return h.json_out({"message": "Не авторизован"}, 401)
    cur_pw = str(body.get("currentPassword") or "")
    new_pw = str(body.get("newPassword") or "")
    if not check_password(cur_pw, user["pass_hash"]):
        return h.json_out({"message": "Текущий пароль неверен"}, 400)
    if len(new_pw) < 6:
        return h.json_out({"message": "Новый пароль минимум 6 символов"}, 400)
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
    mapping = {
        "display_name": "display_name",
        "displayName": "display_name",
        "display-name": "display_name",
        "bio": "bio",
        "username": "username",
    }
    for k, col in mapping.items():
        if k in body and body[k] is not None:
            val = str(body[k]).strip()
            if col == "username":
                if not re.fullmatch(r"[A-Za-z0-9_]{3,20}", val):
                    return h.json_out({"message": "Ник: 3-20 символов (латиница, цифры, _)"}, 400)
                if _db1("SELECT id FROM users WHERE username=? AND id<>?", (val, user["id"])):
                    return h.json_out({"message": "Ник занят"}, 400)
            if col == "display_name" and len(val) > 32:
                return h.json_out({"message": "Display Name максимум 32 символа"}, 400)
            _db("UPDATE users SET %s=? WHERE id=?" % col, (val, user["id"]))
    u = get_user_by_id(user["id"])
    return h.json_out({"success": True, "data": user_json(u), "user": user_json(u)})


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
        fm = re.search(rb'filename="([^"]*)"', header)
        fname = fm.group(1).decode(errors="ignore") if fm else ""
        ext = os.path.splitext(fname)[1].lower()
        if ext not in (".png", ".jpg", ".jpeg", ".gif", ".webp"):
            ext = ".png"
        rel = "/uploads/local/%s_%d%s" % (field, int(time.time() * 1000), ext)
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
    rel = save_upload(h, body, "avatar")
    if not rel:
        return h.json_out({"message": "Файл не получен"}, 400)
    _db("UPDATE users SET avatar=? WHERE id=?", (rel, user["id"]))
    u = get_user_by_id(user["id"])
    return h.json_out({"success": True, "avatar": rel, "data": {"avatar": rel, "user": user_json(u)}, "user": user_json(u)})


@route("POST", "/api/profile/me/cover")
def profile_cover(h, body, user):
    if not require(user):
        return h.json_out({"message": "Не авторизован"}, 401)
    rel = save_upload(h, body, "cover")
    if not rel:
        return h.json_out({"message": "Файл не получен"}, 400)
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
    from urllib.parse import unquote

    uname = unquote(mo.group(1))
    target = _db1("SELECT * FROM users WHERE username=? OR display_name=?", (uname, uname))
    if not target:
        return h.json_out({"message": "Пользователь не найден"}, 404)
    pj = public_user_json(target)
    return h.json_out({"success": True, "data": pj, "user": pj})


@proute("GET", r"^/api/profile/([^/]+)/inventory$")
def profile_inventory(h, mo, body, user):
    from urllib.parse import unquote

    uname = unquote(mo.group(1))
    target = _db1("SELECT id FROM users WHERE username=? OR display_name=?", (uname, uname))
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


@route("GET", "/api/referrals/codes")
def referrals_codes(h, body, user):
    if not require(user):
        return h.json_out({"message": "Не авторизован"}, 401)
    code = user["ref_code"] or ("SNW" + secrets.token_hex(4).upper())
    if not user["ref_code"]:
        _db("UPDATE users SET ref_code=? WHERE id=?", (code, user["id"]))
    item = {
        "id": user["id"],
        "code": code,
        "uses": user["ref_uses"],
        "earned": user["ref_earned"],
        "url": "%s://%s/?ref=%s" % (h.headers.get("X-Forwarded-Proto", "http"), h.headers.get("Host", ""), code),
        "status": "active",
        "created_at": user["created_at"],
    }
    return h.json_out(
        {
            "success": True,
            "data": [item],
            "totalEarned": user["ref_earned"],
            "totalUses": user["ref_uses"],
            "earned": user["ref_earned"],
            "uses": user["ref_uses"],
        }
    )


@route("GET", "/api/daily-bonus/status")
def daily_status(h, body, user):
    if not require(user):
        return h.json_out({"message": "Не авторизован"}, 401)
    last = float(user["last_daily"] or 0)
    left = max(0, int(last + 86400 - time.time()))
    d = {
        "canClaim": left == 0,
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
    row = _db1("SELECT * FROM keys WHERE upper(key)=?", (key,))
    if not row:
        return h.json_out({"message": "Ключ не найден"}, 400)
    if row["used_by"]:
        return h.json_out({"message": "Ключ уже использован"}, 400)
    prod = find_product(row["product_id"]) or {"id": row["product_id"], "title": "Подписка SnowClient #%s" % row["product_id"], "price": 0}
    grant_product(user["id"], prod, "key")
    _db("UPDATE keys SET used_by=?, used_at=? WHERE key=?", (user["id"], now_iso(), row["key"]))
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


@route("POST", "/api/payments/create")
def payments_create(h, body, user):
    if not require(user):
        return h.json_out({"message": "Не авторизован"}, 401)
    if not require_admin(user):
        return h.json_out({"message": "Оплата осуществляется через FunPay."}, 400)
    if "amount" in body:
        try:
            amt = float(body.get("amount") or 0)
        except (TypeError, ValueError):
            amt = 0
        if amt <= 0:
            return h.json_out({"message": "Некорректная сумма"}, 400)
        add_balance(user["id"], amt, deposit=True)
        b, _, _ = get_balance(user["id"])
        return h.json_out({"success": True, "message": "Баланс пополнен", "balance": b, "data": {"balance": b}})
    pid = body.get("productId")
    prod = find_product(pid)
    if not prod:
        return h.json_out({"message": "Товар не найден"}, 400)
    grant_product(user["id"], prod, "pay")
    return h.json_out({"success": True, "message": "Товар успешно приобретен", "data": {"status": "paid"}})


@proute("GET", r"^/api/payments/")
def payments_status(h, mo, body, user):
    return h.json_out({"success": True, "status": "paid", "paid": True, "data": {"status": "paid"}})


@route("POST", "/api/orders/check-promo")
def check_promo(h, body, user):
    return h.json_out({"success": True, "valid": False, "discount": 0, "data": {"valid": False, "discount": 0}})


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
    rows = _db("SELECT * FROM users ORDER BY id")
    out = []
    for r in rows:
        d = {
            "id": r["id"],
            "username": r["username"],
            "email": r["email"],
            "display_name": r["display_name"],
            "role": r["role"],
            "balance": r["balance"],
            "total_deposits": r["total_deposits"],
            "total_purchases": r["total_purchases"],
            "ref_code": r["ref_code"],
            "ref_uses": r["ref_uses"],
            "ref_earned": r["ref_earned"],
            "hwid": r.get("hwid") or "",
            "hwid_bound_at": r.get("hwid_bound_at") or "",
            "created_at": r["created_at"],
            "banned": bool(r["banned"]),
        }
        d["purchases"] = _db1("SELECT COUNT(*) c FROM purchases WHERE user_id=?", (r["id"],))["c"]
        d["cosmetics"] = _db1("SELECT COUNT(*) c FROM inventory WHERE user_id=?", (r["id"],))["c"]
        out.append(d)
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
        _db("UPDATE users SET hwid='', hwid_bound_at='' WHERE id=?", (uid,))
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
        if _db1("SELECT id FROM users WHERE username=? AND id<>?", (val, uid)):
            return h.json_out({"message": "Ник занят"}, 400)
        _db("UPDATE users SET username=? WHERE id=?", (val, uid))
    if "email" in body and body.get("email"):
        val = str(body["email"]).strip().lower()
        if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", val):
            return h.json_out({"message": "Некорректный email"}, 400)
        if _db1("SELECT id FROM users WHERE email=? AND id<>?", (val, uid)):
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
        prod = find_product(body.get("productId")) or {
            "id": int(body.get("productId") or 1),
            "title": "Подписка SnowClient",
            "price": 0,
        }
        grant_product(uid, prod, "admin")
        return h.json_out({"success": True, "message": "Выдан: %s" % prod.get("title")})
    if "cosmeticId" in body:
        try:
            cid = int(body.get("cosmeticId"))
        except (TypeError, ValueError):
            return h.json_out({"message": "Некорректная косметика"}, 400)
        if not _db1("SELECT 1 FROM inventory WHERE user_id=? AND cosmetic_id=?", (uid, cid)):
            _db(
                "INSERT INTO inventory(user_id,cosmetic_id,active,granted_at) VALUES(?,?,0,?)",
                (uid, cid, now_iso()),
            )
        return h.json_out({"success": True, "message": "Косметика #%d выдана" % cid})
    return h.json_out({"message": "Нечего выдавать"}, 400)


@route("POST", "/api/admin/keys")
def admin_keys(h, body, user):
    if not require_admin(user):
        return h.json_out({"message": "Доступ только для админа"}, 403)
    pid = int(body.get("productId") or 1)
    try:
        count = max(1, min(int(body.get("count") or 1), 100))
    except (TypeError, ValueError):
        count = 1
    made = []
    audit(user, "create_keys", "product=%s count=%s" % (pid, count))
    for _ in range(count):
        key = (str(body.get("key") or "").strip() if count == 1 else "") or (
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
            _fails.clear()


def migrate():
    for col in (
        "banned INTEGER NOT NULL DEFAULT 0",
        "totp_secret TEXT",
        "totp_enabled INTEGER NOT NULL DEFAULT 0",
        "totp_last BIGINT NOT NULL DEFAULT 0",
        "backup_codes TEXT NOT NULL DEFAULT ''",
        "hwid TEXT NOT NULL DEFAULT ''",
        "hwid_bound_at TEXT NOT NULL DEFAULT ''",
    ):
        _run("ALTER TABLE users ADD COLUMN IF NOT EXISTS " + col, (), False)
    _run("ALTER TABLE tokens ADD COLUMN IF NOT EXISTS mfa_at DOUBLE PRECISION NOT NULL DEFAULT 0", (), False)
    _run(
        "CREATE TABLE IF NOT EXISTS audit(id SERIAL PRIMARY KEY, ts TEXT NOT NULL, admin_id INTEGER,"
        " admin_name TEXT, action TEXT NOT NULL, detail TEXT)", (), False)


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
    _db("UPDATE users SET backup_codes=? WHERE id=?", (",".join(hs), u["id"]))
    return True


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
    if not is_admin_role(user):
        return h.json_out({"message": "Доступ только для админа"}, 403)
    if user["totp_enabled"]:
        return h.json_out({"message": "2FA уже включена. Сначала отключите её"}, 400)
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
    out = [{"id": p.get("id"), "title": p.get("title"), "price": p.get("price")} for p in prods]
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
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def json_out(self, obj, status=200):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def client_ip(self):
        xff = (self.headers.get("X-Forwarded-For") or "").split(",")
        return (xff[-1].strip() if xff[-1].strip() else self.client_address[0])

   def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        clean_path = self.path.split("?")[0]
        if clean_path in (
            "/admin", "/admin/", "/admin.html", "/admin.js",
            "/cabinet", "/cabinet/", "/cabinet.html", "/cabinet.js",
        ) or self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-store")
        if clean_path in ("/admin", "/admin/", "/admin.html"):
            self.send_header("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
        super().end_headers()

    def bearer_token(self):
        auth = self.headers.get("Authorization") or ""
        if auth.lower().startswith("bearer "):
            return auth[7:].strip()
        return None

    def read_body(self):
        length = self.headers.get("Content-Length")
        if not length:
            return {}
        if int(length) > MAX_BODY:
            return {}
        raw = self.rfile.read(int(length))
        if not raw:
            return {}
        if "multipart/form-data" in (self.headers.get("Content-Type") or ""):
            return raw
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return {}

    def brand(self, data):
        for a, b in BRAND_MAP:
            if a in data:
                data = data.replace(a, b)
        return data

    def _proxy(self, brand=False):
        req = urllib.request.Request(ORIGIN + self.path, method=self.command)
        for h in PROXY_HEADERS:
            if self.headers.get(h):
                req.add_header(h, self.headers[h])
        body = None
        length = self.headers.get("Content-Length")
        if length:
            if int(length) > MAX_BODY:
                return self.json_out({"message": "Слишком большой запрос"}, 413)
            body = self.rfile.read(int(length))
        try:
            with urllib.request.urlopen(req, body, timeout=30) as r:
                data = r.read()
                ctype = r.headers.get("Content-Type") or ""
                if brand and "json" in ctype:
                    data = self.brand(data)
                self.send_response(r.status)
                for k, v in r.headers.items():
                    if k.lower() in ("transfer-encoding", "connection", "content-length", "content-encoding"):
                        continue
                    self.send_header(k, v)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
        except urllib.error.HTTPError as e:
            data = e.read()
            if brand and "json" in (e.headers.get("Content-Type") or ""):
                data = self.brand(data)
            self.send_response(e.code)
            self.send_header("Content-Type", e.headers.get("Content-Type") or "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except Exception as ex:
            self.json_out({"message": "Прокси: %s" % ex}, 502)

    STATIC_OK = ("/static/", "/uploads/local/", "/assets/", "/fonts/")
    STATIC_FILES = (
        "/", "/index.html", "/admin.html", "/admin.js",
        "/cabinet.html", "/cabinet.js",
        "/style.css", "/script.js", "/config.js",
        "/favicon.ico", "/manifest.json", "/robots.txt",
    )

    def _serve_static(self):
        clean = urlsplit(self.path).path
        if clean == "/":
            self.path = "/index.html"
            clean = "/index.html"
        allowed = clean in self.STATIC_FILES or clean.startswith(self.STATIC_OK)
        fs = self.translate_path(self.path)
        if allowed and os.path.isfile(fs):
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
        if method == "GET":
            self.json_out({"success": True, "data": [], "count": 0})
        else:
            self.json_out({"success": True})

    def _handle(self, method):
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
            return self._serve_static()
        body = self.read_body() if method in ("POST", "PUT", "PATCH", "DELETE") else {}
        user = get_user_by_token(self.bearer_token())
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
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS")
        self.end_headers()

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    init_db()
    migrate()
    _run("ALTER TABLE users ADD COLUMN IF NOT EXISTS last_daily DOUBLE PRECISION NOT NULL DEFAULT 0", (), False)
    with http.server.ThreadingHTTPServer(("0.0.0.0", PORT), Handler) as httpd:
        print("listening on", PORT)
        httpd.serve_forever()