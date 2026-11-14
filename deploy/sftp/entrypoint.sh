#!/bin/sh
# Потребители от /etc/sftp/users.conf: име:парола:uid:gid (създават се с „qr sftp-add“).
set -e
mkdir -p /etc/ssh/keys
[ -f /etc/ssh/keys/ssh_host_ed25519_key ] || ssh-keygen -q -t ed25519 -f /etc/ssh/keys/ssh_host_ed25519_key -N ''
[ -f /etc/ssh/keys/ssh_host_rsa_key ] || ssh-keygen -q -t rsa -b 3072 -f /etc/ssh/keys/ssh_host_rsa_key -N ''
if [ -f /etc/sftp/users.conf ]; then
  while IFS=: read -r user pass uid gid; do
    case "$user" in ''|\#*) continue ;; esac
    id "$user" >/dev/null 2>&1 || useradd -o -u "${uid:-1000}" -g "${gid:-1000}" -d "/home/$user" -M -s /usr/sbin/nologin "$user"
    echo "$user:$pass" | chpasswd
    # chroot изисква папката на потребителя да е на root и да не е записваема за други.
    if [ -d "/home/$user" ]; then chown root:root "/home/$user"; chmod 755 "/home/$user"; fi
  done < /etc/sftp/users.conf
fi
echo "SFTP готов"
exec /usr/sbin/sshd -D -e
