#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════
#  SignDevis — Déploiement Debian 12 (SQLite, sans MongoDB)
#  Cible : /var/www/signature/
#  Usage : sudo bash /var/www/signature/deploy_debian.sh
# ═══════════════════════════════════════════════════════════════════════════
set -e

APP_DIR="/var/www/signature"
BACKEND_DIR="$APP_DIR/backend"
FRONTEND_DIR="$APP_DIR/frontend"
DOMAIN="signature.lesbruneau.fr"
SERVICE="soizic-backend"

echo "═══ 1. Paquets système ═══"
apt-get update
apt-get install -y python3 python3-venv python3-pip git curl nginx ca-certificates gnupg

# Node.js 20.x
if ! command -v node &>/dev/null || [[ "$(node -v | cut -dv -f2 | cut -d. -f1)" -lt 18 ]]; then
    echo "→ Installation Node.js 20.x"
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
fi
# Yarn
if ! command -v yarn &>/dev/null; then
    corepack enable
    corepack prepare yarn@1.22.22 --activate || npm install -g yarn
fi
echo "→ Node: $(node -v) · Yarn: $(yarn -v) · Python: $(python3 --version)"

echo ""
echo "═══ 2. Permissions du dossier ═══"
chown -R root:root "$APP_DIR"
mkdir -p "$BACKEND_DIR/templates"

echo ""
echo "═══ 3. backend/.env ═══"
if [ ! -f "$BACKEND_DIR/.env" ]; then
    cat > "$BACKEND_DIR/.env" <<EOF
# SQLite (aucun serveur de base de données à installer)
DB_NAME=soizic
SQLITE_PATH=$BACKEND_DIR/soizic.db
JWT_SECRET=$(openssl rand -hex 32)

# CORS : domaines autorisés (HTTP + HTTPS)
CORS_ORIGINS=http://${DOMAIN},https://${DOMAIN}

# Cookies : true en HTTPS production
COOKIE_SECURE=true
COOKIE_SAMESITE=lax
EOF
    echo "→ $BACKEND_DIR/.env créé"
else
    echo "→ $BACKEND_DIR/.env déjà présent, on conserve"
fi

echo ""
echo "═══ 4. frontend/.env ═══"
cat > "$FRONTEND_DIR/.env" <<EOF
# URL relative : le frontend appelle /api/... via nginx, même origine
REACT_APP_BACKEND_URL=
WDS_SOCKET_PORT=443
EOF
echo "→ $FRONTEND_DIR/.env créé"

echo ""
echo "═══ 5. Dépendances Python (venv) ═══"
cd "$BACKEND_DIR"
rm -rf venv
python3 -m venv venv
# shellcheck disable=SC1091
source venv/bin/activate
pip install --upgrade pip wheel
pip install -r requirements.txt
deactivate
echo "→ venv prêt : $BACKEND_DIR/venv"

echo ""
echo "═══ 6. Smoke test backend ═══"
cd "$BACKEND_DIR"
# shellcheck disable=SC1091
source venv/bin/activate
nohup uvicorn server:app --host 127.0.0.1 --port 8001 > /tmp/soizic_smoke.log 2>&1 &
TEST_PID=$!
sleep 4
if curl -sf http://127.0.0.1:8001/api/ > /dev/null; then
    echo "→ Backend OK ✅"
else
    echo "→ Backend KO ❌"
    cat /tmp/soizic_smoke.log
    kill $TEST_PID 2>/dev/null || true
    exit 1
fi
kill $TEST_PID 2>/dev/null || true
deactivate
sleep 1

echo ""
echo "═══ 7. Service systemd ═══"
cat > /etc/systemd/system/${SERVICE}.service <<EOF
[Unit]
Description=SignDevis Backend (FastAPI, SQLite)
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=$BACKEND_DIR
Environment="PATH=$BACKEND_DIR/venv/bin"
ExecStart=$BACKEND_DIR/venv/bin/uvicorn server:app --host 127.0.0.1 --port 8001
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable ${SERVICE}
systemctl restart ${SERVICE}
sleep 3
if systemctl is-active --quiet ${SERVICE}; then
    echo "→ Service ${SERVICE} actif ✅"
else
    echo "→ Service KO ❌"; journalctl -u ${SERVICE} -n 40 --no-pager
    exit 1
fi

echo ""
echo "═══ 8. Build frontend ═══"
cd "$FRONTEND_DIR"
rm -rf build node_modules
yarn install
yarn build
echo "→ Build créé : $FRONTEND_DIR/build ✅"

echo ""
echo "═══ 9. Nginx ═══"
cat > /etc/nginx/sites-available/signature <<EOF
server {
    listen 80;
    server_name ${DOMAIN};

    root ${FRONTEND_DIR}/build;
    index index.html;

    client_max_body_size 20M;

    # SPA : routes côté React
    location / {
        try_files \$uri /index.html;
    }

    # API + worker PDF.js servis par le backend
    location /api/ {
        proxy_pass http://127.0.0.1:8001;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 120s;
    }

    # Cache long pour les assets statiques (hash dans le nom du fichier)
    location /static/ {
        expires 30d;
        add_header Cache-Control "public, immutable";
    }
}
EOF
ln -sf /etc/nginx/sites-available/signature /etc/nginx/sites-enabled/signature
nginx -t && systemctl reload nginx
echo "→ nginx rechargé ✅"

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  ✅ DÉPLOIEMENT TERMINÉ"
echo "═══════════════════════════════════════════════════════"
echo ""
echo "Test API local :"
curl -s http://127.0.0.1:8001/api/ && echo ""
echo "Test API via nginx :"
curl -s http://${DOMAIN}/api/ && echo ""
echo ""
echo "→ App accessible sur : http://${DOMAIN}"
echo "→ Identifiants par défaut : admin / admin123"
echo "→ Modifier les comptes : $BACKEND_DIR/config.py puis  systemctl restart ${SERVICE}"
echo ""
echo "Logs en direct :"
echo "  journalctl -u ${SERVICE} -f"
echo ""
echo "PROCHAINE ÉTAPE (HTTPS) :"
echo "  apt install certbot python3-certbot-nginx"
echo "  certbot --nginx -d ${DOMAIN}"
