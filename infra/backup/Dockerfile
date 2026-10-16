# Image des sauvegardes : pg_dump (client 17) + age + rclone.
FROM alpine:3.23
RUN apk add --no-cache postgresql17-client age rclone
COPY backup.sh /usr/local/bin/backup.sh
RUN chmod 0755 /usr/local/bin/backup.sh
CMD ["/usr/local/bin/backup.sh"]
