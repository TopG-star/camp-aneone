# ADR-015: Backup Strategy

## Status: Accepted, with open questions

## Date: 2026-10-14

## Context

Spec section 8.7 asks for per-file backups with SQLite's online backup API, encrypted before they leave the VPS, with a monthly restore test, replacing the manual `cp` in DEPLOY.md (which can copy a file in the middle of a write). The first build (Task 24, ADR-013 entries B-24-1 to B-24-5) wrote nightly sealed copies and a pre-migration copy, and deleted nothing.

After the CTO review, post-review item 3 added alerts that measure backups by age (ADR-013 B-PR-4). Because backups touch keys and deletion, the choices about hourly copies, Litestream and retention went to the owner under the stop rule (ADR-016). Gerry decided D2 (keys), D3 and D6 (deletion) and D5 (suspended pharmacies) on 2026-10-14 (ADR-013 entries B-PR-9, B-PR-10, B-PR-14 and B-PR-12). Litestream was researched first: version 0.5.x can replicate a directory of per-tenant files with watch (v0.5.4 and later), but it has no client-side encryption (age was removed in 0.5; only S3 server-side SSE-C or SSE-KMS remain). Oneon's rule is that backups are encrypted before they leave the VPS, so Litestream does not meet it.

## Decision

Accepted:

1. **Sealed copies.** Every backup is sealed with AES-256-GCM under `BACKUP_ENCRYPTION_KEY` (base64 of 32 bytes). The associated data is `<folder>/<name>`: `<day>/<name>.db.enc` for a daily copy, `<yyyy-mm-ddThhZ>/<name>.db.enc` for an hourly one. One file's copy therefore cannot be presented as another's or moved into another folder without `--as` on restore.
2. **Two kinds of schedule.** Daily snapshots of `control`, `personal` and every active or suspended pharmacy. Hourly sealed copies of `control` and of every active or suspended pharmacy. The personal file is daily only. A day or an hour is written into a `.partial` folder and renamed only when every file succeeded. A copy is also taken before every pending migration (`pre-migration/<timestamp>/`).
3. **Suspended pharmacies stay backed up.** A pharmacy suspended by the operator is in the daily set, the hourly set, and the stale check. Startup migrates suspended files too, with the sealed pre-migration copy first, so a release that adds a migration does not leave a suspended file behind and refused by backups. A removed pharmacy is not backed up.
4. **Alerts.** `backup_stale` is logged at error, every hour until fixed, when the newest restorable copy of `control`, `personal` or a pharmacy is older than 26 hours or missing. A pharmacy with no copy is measured from the later of its enrolment and the last time it became active. `tenant_file_missing` is logged at error every night when an active or suspended pharmacy's file is not on disk. A pharmacy the gate refuses to open is skipped, listed in `skipped.json`, and the day completes without it.
5. **Never delete the newest copy of any file.** This holds for whoever deletes (by hand, by the hourly retention, or by a later B-retention) and for `control`, `personal` and every pharmacy, including a skipped pharmacy's last good copy under `pre-migration/` or in an old hourly folder.
6. **Automatic retention of hourly copies only (owner decision D6).** After each successful hourly copy, Oneon keeps the 48 most recent hourly copies and deletes older hourly ones. Daily snapshots and everything under `pre-migration/` are never deleted by Oneon; the operator prunes them. The code counts the 48 most recent complete hourly folders and protects the newest copy of any file inside them. Whether D6 meant 48 per file or 48 per folder is open (below).
7. **Litestream is deferred** until it regains client-side encryption. The daily snapshots are the independent second copy: a separately sealed set written by the nightly job, which the hourly retention never touches. They are not independent of the disk: until a copy has been synced off-site, hourly and daily copies sit on the same disk as the databases, and losing that disk loses them too.
8. **Restore.** A monthly test restores one pharmacy (rotating) into a temporary folder, runs `PRAGMA integrity_check`, and requires `context_meta` kind `tenant` with the `tenant_id` of the registration that owns the file. `restore-backup` decrypts one file at a time.

## Data-loss window

- Pharmacies and `control`: up to one hour of writes since the last successful hourly copy, if the disk survives. A failed hour is retried at the next hourly check, and `backup_stale` only fires after 26 hours, so a stuck backup can go unnoticed for up to a day unless someone reads the error log for "Hourly backup failed".
- Personal file: up to one day.
- If the VPS disk is lost, the window is back to the last off-site sync, not the last copy. Off-site sync is the operator's job (DEPLOY.md gives an `rclone` example); Oneon does not do it.
- A pre-migration copy is taken before each migration, so a file can be restored to its state before that migration.

## Open questions awaiting the owner

These touch deletion, so they wait for the owner (ADR-016). Nothing is built to resolve them.

1. **Retention per file or per folder.** D6 said the most recent 48 hourly copies per file. The code keeps 48 hourly folders and keeps any file that is the newest copy of itself. The two differ, for example, for a pharmacy that was skipped for some hours: it has fewer than 48 copies among the last 48 folders, and a per-file count would keep more folders for it. The review of the built work raised this as I3.
2. **Leftover hourly `.partial` folders.** Retention never deletes a `.partial` folder, and a `.partial` folder does not count toward the 48. The ledger records that leftover hourly `.partial` folders are never deleted. Should Oneon delete such leftovers once a newer complete hour exists?
3. **`rclone copy` versus `rclone sync` off-site.** DEPLOY.md's example uses `rclone sync`, which mirrors deletions, so the hourly copies that retention deletes are deleted off-site as well. `rclone copy` keeps them, and the off-site store then grows without limit unless someone prunes it. Which one is right is a deletion policy for the second copy.

## Consequences

- A backup is only as recoverable as `BACKUP_ENCRYPTION_KEY`. DEPLOY.md tells the operator to keep a copy of the key somewhere other than the VPS. Without the key, no backups are made; once any pharmacy is registered, the server refuses to start without it and enrolment is refused.
- Disk use grows by about 48 hourly copies of every pharmacy and `control`, plus a daily folder per day and pre-migration folders, which the operator prunes until a later B-retention exists.
- Alerts are log lines (`alert: "backup_stale"`, `alert: "tenant_file_missing"`). No outside channel exists, so nobody is told unless someone reads the logs (ADR-013 B-25-4).
- Only one pharmacy per month is restore-tested. A copy of another pharmacy may be unreadable without anyone noticing.
- Not built: B-retention (deleting daily and pre-migration copies on the file's own schedule, spec section 8.7).
- Not verified: the backup code ran under the repository's test gates only. No production backup or restore has run.
