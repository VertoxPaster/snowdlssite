# Проверка капчи Cloudflare Turnstile на сервере.
# Секретный ключ НЕ храним в коде и в репозитории (он публичный!) —
# задайте переменную окружения TURNSTILE_SECRET на сервере.
import os, json, urllib.parse, urllib.request

def verify_turnstile(token, ip=None):
    if not token:
        return False
    fields = {"secret": os.environ["TURNSTILE_SECRET"], "response": token}
    if ip:
        fields["remoteip"] = ip
    data = urllib.parse.urlencode(fields).encode()
    try:
        with urllib.request.urlopen(
            "https://challenges.cloudflare.com/turnstile/v0/siteverify", data=data, timeout=8
        ) as r:
            return json.load(r).get("success") is True
    except Exception:
        return False

# В обработчиках POST /api/auth/login и POST /api/auth/register, ДО проверки пароля:
#     if not verify_turnstile(body.get("turnstileToken"), client_ip):
#         return error(400, "Капча не пройдена")
