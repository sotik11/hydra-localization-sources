# CI workflows

## `failsafe-snapshot.yml` — bi-weekly `stable → main` snapshot

Bi-weekly cron that copies the live `stable` feed into `main` **only if** every
`data/*.json` in `stable` passes a sanity check against its counterpart in
`main`. Purpose: users whose Hydra source URL happens to point at `main` always
have a known-good backup of the whole catalogue, without ever getting a broken
snapshot saved as "known good".

**Schedule:** 1st and 15th of every month at 03:00 UTC (~14-day cadence).
**Manual trigger:** `Actions → Failsafe snapshot → Run workflow` (with optional
dry-run mode for testing sanity thresholds without pushing).

### Sanity thresholds (see `scripts/sanity-check.mjs`)

For every `data/*.json` in `stable`:

1. Valid JSON with a `localizations: []` array.
2. `count >= 90% × count(main)` — protects against "parser returned nothing".
3. `appid coverage >= 60%` — protects against resolver regression.
4. `fileSize >= 50% × fileSize(main)` — protects against truncation.

New files (present in `stable`, absent in `main`) are accepted without a
baseline comparison.

### Telegram secrets

Configure in `Settings → Secrets and variables → Actions`:

- `TELEGRAM_BOT_TOKEN` — bot token from @BotFather
- `TELEGRAM_CHAT_ID` — chat/channel id where notifications land

Both success and failure runs post to Telegram. Failures also fail the job so
it shows red in the Actions tab.

### If sanity fails — manual triage

The failure Telegram message names the offending file(s) and reason. Typical
causes: parser broken on the source site, resolver returning too many nulls
after an override edit gone wrong. Fix in `stable` first (re-run generator,
push), then re-trigger the workflow via `workflow_dispatch`.

### If `stable` itself is broken and users are affected — emergency rollback

Nuke `stable` from the last-good `main`:

```bash
git checkout stable
git reset --hard main
git push --force origin stable
```

CDN picks it up in ~5 min.
