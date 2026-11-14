#!/usr/bin/env bash
# Инсталатор на „QR поръчки“. Пуска се веднъж на сървъра:  sudo bash install.sh
# Задава няколко въпроса, инсталира Docker (ако липсва), генерира тайните и пуска системата.
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(pwd)"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '\033[32m✔ %s\033[0m\n' "$*"; }
warn() { printf '\033[33m⚠ %s\033[0m\n' "$*"; }
die()  { printf '\033[31m✘ %s\033[0m\n' "$*"; exit 1; }
ask()  { local q="$1" def="${2:-}" a; if [ -n "$def" ]; then read -rp "$q [$def]: " a; echo "${a:-$def}"; else read -rp "$q: " a; echo "$a"; fi; }
rand() { openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c "${1:-32}"; }

[ "$(id -u)" -eq 0 ] || die "Пуснете с sudo:  sudo bash install.sh"
[ "$(uname -s)" = "Linux" ] || die "Инсталаторът е за Linux сървър (Ubuntu/Debian). Вижте docs/INSTALL.md."

bold "═══ QR поръчки — инсталация ═══"
echo

if [ -f server.env ]; then
  ok "Системата вече е инсталирана. Пускам я (ако е спряна)…"
  ./qr start
  exit 0
fi

# 1. Docker
if ! command -v docker >/dev/null 2>&1; then
  bold "Инсталирам Docker (няколко минути)…"
  command -v curl >/dev/null 2>&1 || (apt-get update -qq && apt-get install -y -qq curl)
  curl -fsSL https://get.docker.com | sh >/dev/null
  systemctl enable --now docker >/dev/null 2>&1 || true
fi
docker compose version >/dev/null 2>&1 || die "Липсва „docker compose“. Обновете Docker и опитайте пак."
command -v openssl >/dev/null 2>&1 || (apt-get update -qq && apt-get install -y -qq openssl)
ok "Docker е готов"
echo

# 2. Режим
bold "Как ще работи системата?"
echo "  1) В интернет — с ваш домейн и HTTPS (препоръчително; клиентите поръчват от мобилните си данни)"
echo "  2) Проба в локалната мрежа — без домейн; работи само през WiFi-то на обекта"
MODE=$(ask "Изберете 1 или 2" "1")
echo

INSECURE=0; CADDYFILE=Caddyfile; ACME_EMAIL=""
if [ "$MODE" = "1" ]; then
  DOMAIN=$(ask "Вашият домейн (напр. poruchki.bg)")
  DOMAIN=$(echo "$DOMAIN" | tr 'A-Z' 'a-z' | sed -e 's#^https\?://##' -e 's#/.*##' -e 's/^www\.//')
  [ -n "$DOMAIN" ] || die "Домейнът е задължителен."
  ACME_EMAIL=$(ask "Имейл за известия за сертификатите (Let's Encrypt)")
  IP=$(curl -fsS4 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
  echo
  bold "Проверка на DNS"
  echo "При регистратора на домейна трябва да има два записа тип A към този сървър ($IP):"
  echo "   $DOMAIN        A   $IP"
  echo "   *.$DOMAIN      A   $IP"
  RES=$(getent hosts "admin.$DOMAIN" | awk '{print $1}' | head -1 || true)
  if [ "$RES" = "$IP" ]; then ok "DNS е наред"; else
    warn "admin.$DOMAIN сочи към „${RES:-нищо}“, а трябва към $IP."
    warn "Може да продължите — HTTPS ще тръгне сам, щом DNS се обнови (до няколко часа)."
  fi
  BASE_DOMAIN="$DOMAIN"
else
  LAN_IP=$(hostname -I | awk '{print $1}')
  LAN_IP=$(ask "IP адрес на този компютър в мрежата" "$LAN_IP")
  BASE_DOMAIN="$(echo "$LAN_IP" | tr '.' '-').nip.io"
  INSECURE=1; CADDYFILE=Caddyfile.local
fi
echo

# 3. Имейл (по избор)
bold "Имейли (дневен отчет, грешки в импорта) — по избор"
echo "За Gmail: създайте „парола за приложение“ в профила си (Сигурност → Пароли за приложения)."
SMTP_USER=$(ask "Имейл адрес за изпращане (Enter = пропусни)" "")
SMTP_URL=""; MAIL_FROM=""
if [ -n "$SMTP_USER" ]; then
  read -rsp "Парола за приложение: " SMTP_PASS; echo
  SMTP_HOST=$(ask "SMTP сървър" "smtp.gmail.com")
  ENC_USER=$(printf '%s' "$SMTP_USER" | sed 's/@/%40/g'); ENC_PASS=$(printf '%s' "$SMTP_PASS" | sed -e 's/%/%25/g' -e 's/@/%40/g' -e 's/:/%3A/g' -e 's#/#%2F#g' -e 's/ //g')
  SMTP_URL="smtps://$ENC_USER:$ENC_PASS@$SMTP_HOST:465"
  MAIL_FROM="QR поръчки <$SMTP_USER>"
fi

# 4. Тайни и настройки
SETUP_CODE="$(rand 4 | tr 'a-z' 'A-Z')-$(rand 4 | tr 'a-z' 'A-Z')"
umask 077
cat > server.env <<ENV
# Генерирано от install.sh на $(date '+%F %T'). Пазете този файл — в него са тайните.
BASE_DOMAIN=$BASE_DOMAIN
ACME_EMAIL=$ACME_EMAIL
CADDYFILE=$CADDYFILE
INSECURE_COOKIES=$INSECURE
PG_SUPERUSER_PASSWORD=$(rand 32)
QR_OWNER_PASSWORD=$(rand 32)
QR_APP_PASSWORD=$(rand 32)
SECRETS_KEY=$(openssl rand -base64 32)
QR_TOKEN_SECRET=$(rand 48)
CONTACT_HASH_KEY=$(rand 48)
SETUP_CODE=$SETUP_CODE
SMTP_URL=$SMTP_URL
MAIL_FROM="$MAIL_FROM"
ENV
umask 022
mkdir -p data/postgres data/import data/caddy data/sftp/keys backups
# SFTP (chroot) изисква горните папки да са на root; подпапките на бизнесите се правят с „qr sftp-add“.
chown root:root data/import && chmod 755 data/import
chmod +x qr
ln -sf "$ROOT/qr" /usr/local/bin/qr
ok "Настройките са записани в $ROOT/server.env"
echo

# 5. Стартиране
bold "Строя и пускам системата (първия път 3–10 минути)…"
./qr start
echo
for i in $(seq 1 60); do
  if ./qr health >/dev/null 2>&1; then break; fi; sleep 3
done
./qr health >/dev/null 2>&1 || warn "Системата още тръгва. Проверете след минута с:  qr status"

SCHEME=https; [ "$INSECURE" = "1" ] && SCHEME=http
echo
bold "═══ Готово! ═══"
echo
echo "1. Отворете в браузър:   $SCHEME://admin.$BASE_DOMAIN"
echo "2. Въведете кода за настройка:   $SETUP_CODE"
echo "3. Създайте администратор, после — първия бизнес."
echo
echo "Полезни команди:  qr status · qr logs · qr backup · qr update · qr help"
