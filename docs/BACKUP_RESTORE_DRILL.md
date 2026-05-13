# Backup Restore Drill

Proves the backup pipeline actually works — dumps prod, restores to a
scratch DB, runs a sanity query, reports green/red. Run this BEFORE the
first customer trusts gluecron with their repos. Then run it monthly
from cron so the drill is rehearsed continuously, not theoretically.

## Pre-reqs

- `pg_dump` and `psql` on PATH (`apt-get install -y postgresql-client` on the box)
- `DATABASE_URL` pointing at the prod DB (Neon)
- `SCRATCH_DATABASE_URL` pointing at a writable empty DB (Neon branch is
  ideal; can also be a local Postgres for the drill)
- Disk space for the dump (a few hundred MB once gluecron has real users)

## Run it

```sh
docker compose exec gluecron bash scripts/backup-restore-drill.sh
```

Or manually from anywhere with `psql`:

```sh
DATABASE_URL="postgresql://...prod..." \
SCRATCH_DATABASE_URL="postgresql://...scratch..." \
bash scripts/backup-restore-drill.sh
```

The script:

1. `pg_dump --format=custom` the prod DB into `/tmp/gluecron-drill-<ts>.dump`
2. Drops + recreates `users` (and a few other key tables) in the scratch DB
3. `pg_restore` the dump into scratch
4. Runs verification queries:
   - `SELECT COUNT(*) FROM users;` matches prod
   - `SELECT COUNT(*) FROM repositories;` matches prod
   - `SELECT COUNT(*) FROM site_admins;` matches prod
   - Schema row count from `information_schema.tables` matches prod
5. Reports PASS/FAIL per check and a summary at the end
6. Cleans up the dump file unless `--keep-dump` is passed

A failed drill is a paging-grade alert. The most common cause is a
schema drift between the dump and the restore DB — fix by either
resetting scratch (`DROP DATABASE; CREATE DATABASE`) or by running
`bun run db:migrate` on it before restoring.

## Cron it

Monthly is enough for the v1 user base. Add this to the box's crontab
(remember to keep the env file accessible):

```cron
# At 03:00 on day-of-month 1, run the backup-restore drill, log the result.
0 3 1 * *  cd /opt/gluecron && /usr/bin/env bash scripts/backup-restore-drill.sh >> /var/log/gluecron/drill.log 2>&1
```

Then scrape the log via the existing alerting rule
(`infra/alerts/gluecron.rules.yml`) by adding a once-monthly
`drill_last_success_seconds` metric — the script writes a tiny
`/var/lib/gluecron/drill-last-success` timestamp file when it passes
which you can convert to a metric via node_exporter's textfile collector.

## What "green" looks like

```
[drill 2026-05-13 03:00:01] dumping prod DB ...
[drill 2026-05-13 03:00:08] dump complete: 47 MB at /tmp/gluecron-drill-1715569201.dump
[drill 2026-05-13 03:00:08] restoring into scratch ...
[drill 2026-05-13 03:00:31] restore complete
[drill 2026-05-13 03:00:31] verification:
  PASS  users count        prod=128         scratch=128
  PASS  repositories count prod=412         scratch=412
  PASS  site_admins count  prod=2           scratch=2
  PASS  schema tables      prod=96          scratch=96
[drill 2026-05-13 03:00:32] All checks passed. Took 31s.
```

## What "red" looks like

```
  FAIL  users count        prod=128         scratch=0
```

=> the restore didn't actually populate. Re-run with `--verbose` and check
   `pg_restore` output. Usually a permissions issue on the scratch DB.

```
  FAIL  schema tables      prod=96          scratch=84
```

=> schema drift. Run `bun run db:migrate` against scratch, then re-run.
