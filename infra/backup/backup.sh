#!/bin/sh
# Sauvegarde chiffrée de Postgres, toutes les 24 h.
#
#   pg_dump | gzip | age -r $BACKUP_AGE_RECIPIENT > /backups/radarnaque-<date>.sql.gz.age
#   rclone copy vers $BACKUP_RCLONE_REMOTE, puis suppression des sauvegardes locales de plus de 14 jours.
#
# Sans argument : boucle infinie (une sauvegarde au démarrage, puis toutes les 24 h ; une
# erreur est journalisée sur stderr et la boucle continue). `--once` : une seule sauvegarde,
# code de sortie non nul au premier échec (BACKUP_RUN_ONCE=1 équivaut à `--once`).
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/backups}"
RETENTION_DAYS=14

if [ "${1:-}" != "--once" ] && [ "${BACKUP_RUN_ONCE:-0}" != "1" ]; then
	while true; do
		# Processus fils : `set -e` y reste actif (il serait ignoré dans un `if`).
		"$0" --once || echo "[backup] ERREUR : sauvegarde en échec (code $?)" >&2
		sleep 86400
	done
fi

: "${BACKUP_AGE_RECIPIENT:?BACKUP_AGE_RECIPIENT manquante (clé publique age1...)}"
: "${BACKUP_RCLONE_REMOTE:?BACKUP_RCLONE_REMOTE manquante (ex. remote:radarnaque)}"
: "${PGHOST:?PGHOST manquante}"
: "${PGUSER:?PGUSER manquante}"
: "${PGPASSWORD:?PGPASSWORD manquante}"
: "${PGDATABASE:?PGDATABASE manquante}"

mkdir -p "$BACKUP_DIR"
file="$BACKUP_DIR/radarnaque-$(date -u +%Y%m%dT%H%M%SZ).sql.gz.age"
partial="$file.partial"
trap 'rm -f "$partial"' EXIT

echo "[backup] pg_dump de $PGDATABASE@$PGHOST vers $file"
# pipefail : un échec de pg_dump fait échouer tout le pipeline (et donc le script).
pg_dump --no-owner --no-privileges | gzip | age -r "$BACKUP_AGE_RECIPIENT" >"$partial"
mv "$partial" "$file"
echo "[backup] sauvegarde écrite ($(wc -c <"$file") octets)"

rclone copy "$file" "$BACKUP_RCLONE_REMOTE"
echo "[backup] copie vers $BACKUP_RCLONE_REMOTE terminée"

find "$BACKUP_DIR" -name 'radarnaque-*.sql.gz.age' -type f -mtime +"$RETENTION_DAYS" -delete
echo "[backup] sauvegardes locales de plus de $RETENTION_DAYS jours supprimées"
