# P0 Crontab & Logrotate — VPS Reference

Install on the VPS once Cloudflare R2 is configured and `scripts/backup-pg.sh` /
`scripts/restore-pg-drill.sh` are deployed.  Run as `root` (or a dedicated
`animego` user; the cron will need read access to `/opt/animego/`).

## Pre-install

```bash
# Log directory (one-time, on the VPS)
sudo install -d -o root -g root -m 0755 /var/log/animego
```

## Crontab

`sudo crontab -e -u root` — paste this block:

```cron
CRON_TZ=UTC
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# 03:00 UTC nightly backup (prod compose)
0 3 * * *  cd /opt/animego && /opt/animego/scripts/backup-pg.sh --env=prod >> /var/log/animego/backup.log 2>&1

# 04:00 UTC daily retention sweep (30d)
#   rclone delete --min-age 30d: removes objects older than 30d
#   https://rclone.org/commands/rclone_delete/
0 4 * * *  rclone delete --min-age 30d r2:animego-backup/ >> /var/log/animego/retention.log 2>&1

# 05:00 UTC Sunday-only restore drill (P0 → P1 gate; weekly so cost stays low)
0 5 * * 0  cd /opt/animego && /opt/animego/scripts/restore-pg-drill.sh >> /var/log/animego/restore-drill.log 2>&1
```

> **Timezone:** `CRON_TZ=UTC` is explicit so the schedule doesn't drift if
> the VPS timezone is later changed.  Verify with `timedatectl` — animego's
> VPS is UTC already, but be explicit so future you doesn't have to remember.

## Logrotate

`sudo tee /etc/logrotate.d/animego` — paste:

```
/var/log/animego/*.log {
    weekly
    rotate 8
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
    su root root
}
```

Test rotation:
```bash
sudo logrotate -d /etc/logrotate.d/animego   # dry run
sudo logrotate -f /etc/logrotate.d/animego   # force run
```

## Validation (post-install)

```bash
# Verify cron picked up the entries
sudo crontab -l -u root | grep animego

# After 03:00 UTC has passed, check that backup ran
tail -20 /var/log/animego/backup.log
rclone ls r2:animego-backup/ | head

# After Sunday 05:00 UTC, check that restore drill ran
tail -50 /var/log/animego/restore-drill.log
grep "^PASS\|^FAIL" /var/log/animego/restore-drill.log
```

## Manual test before letting cron own this

Before relying on the schedule, run each step at least once by hand on the
VPS to prove permissions and rclone config are good:

```bash
# As whoever owns the crontab (root recommended)
cd /opt/animego
./scripts/backup-pg.sh --env=prod
./scripts/restore-pg-drill.sh
rclone delete --min-age 30d r2:animego-backup/
```
