# hydra-localization-sources

Генератори, що збирають JSON-фіди (формат `LocalizationFile`) для фан-локалізацій
у [форку Hydra](https://github.com/sotik11/hydra). Кожне джерело — модуль у
`generators/`, вивід — `data/<src>.json`, який роздається як сирий файл
(`raw.githubusercontent.com/.../data/<src>.json`) і додається в Hydra як
джерело локалізацій.

## Запуск

```bash
npm install
node generators/<src>.mjs        # одне джерело
bash regen_all.sh                # усі: снапшот → реген за порядком → авто-відкат при деградації
```

`regen_all.sh` спочатку копіює кожну базу в `data/*.json.backup`, проганяє
генератори за порядком залежностей (`revoiceai → playground → synthvoiceru`,
решта потім) і, якщо джерело повернулося < 50 % від бекапу, **відновлює бекап** —
куций/заблокований прогін не затирає добрі дані.

## Джерела (14)

| джерело | сайт | мова | нотатка |
|---|---|---|---|
| playground | playground.ru | 🇷🇺 | агрегатор, browser-only |
| magyaritasok | magyaritasok.hu | 🇭🇺 | агрегатор, direct |
| kuli | kuli.com.ua | 🇺🇦 | агрегатор, direct/cloud |
| lbk | lbklauncher.com | 🇺🇦 | агрегатор, через лаунчер |
| lokalizace | lokalizace.net | 🇨🇿 | агрегатор, direct |
| komunitni-preklady | komunitni-preklady.org | 🇨🇿🇸🇰 | агрегатор, direct |
| tribogamer | tribogamer.com | 🇧🇷 | агрегатор, direct (Cloudflare) |
| gpp | grajpopolsku.pl | 🇵🇱 | агрегатор, direct |
| hernipreklady | hernipreklady.cz | 🇨🇿 | агрегатор, direct |
| mvo | rgmvo.ru | 🇷🇺 | студія, cloud |
| synthvoiceru | boosty.to/synthvoiceru | 🇷🇺 | нейро-студія |
| revoiceai | boosty.to/revoice | 🇷🇺 | нейро-студія |
| turkce-yama | turkce-yama.com | 🇹🇷 | агрегатор, browser-only (Cloudflare) |
| calypsoceviri | calypsoceviri.com | 🇹🇷 | студія, direct (Cloudflare) |

Спільний мережевий шар — `lib/net.mjs` (ретраї + бекоф на 429/5xx, пул,
`getTextCurl` для Cloudflare-сайтів, `formatBytes`/`normalizeSize`).

## Автооновлення

`.github/workflows/regenerate.yml` — cron (раз на добу) проганяє все й комітить
свіжі дані. Частина сайтів блокує дата-центрові IP GitHub — для них повний рефреш
робиться локально (див. нижче).

<details>
<summary>Деталі про блокування IP</summary>

За прогоном 2026-06-29 з раннера не оновлюються `tribogamer`,
`komunitni-preklady` й `magyaritasok` (віддають 403 / блок-сторінку). Для них
спрацьовує degradation-guard (лишаються останні добрі дані), а повний рефреш
робиться локально з residential IP. Прикметно: два Cloudflare-сайти `turkce-yama`
й `calypsoceviri` через `getTextCurl` (системний curl + Schannel) з раннера
**проходять** — тобто річ не стільки в Cloudflare як такому, скільки в політиці
конкретного сайту до IP/фінгерпринту.

</details>

## Локальний авто-рефреш заблокованих джерел

Три джерела — `komunitni-preklady`, `magyaritasok`, `tribogamer` — ріжуться за
**дата-центровим IP GitHub** (підтверджено 2026-06-29: на раннері `0`, з домашнього
IP — повні лічильники; блок саме за IP, не за TLS-фінгерпринтом — `getTextCurl` на
раннері для них теж дає `0`). Тому їх оновлює локально, з residential-IP:

```bash
bash refresh_local.sh   # pull --rebase → реген 3 → degradation guard → commit/push лише цих 3
```

<details>
<summary>Деталі, розклад (Task Scheduler) та поведінка догону</summary>

- логіка та сама, що в `regen_all.sh` (снапшот + відкат при деградації < 50 %);
- увесь вивід дублюється у `refresh_local.log` (gitignored);
- старт і фініш (з лічильниками за джерелами) ідуть у **Windows-тости** через
  `notify.ps1` (вбудований WinRT `ToastNotificationManager`, без сторонніх
  модулів; запускається через `powershell.exe` 5.1);
- еталонні лічильники: **komunitni 619, magyaritasok 2050, tribogamer 475**
  (повний прогін ~26 хв, magyaritasok найдовший);
- `*.sh` залочені на LF через `.gitattributes` — інакше CRLF-checkout ламає
  bash-задачі.

**Розклад (Windows Task Scheduler).** Задача **«Hydra localization refresh»**:
щодня **15:00 локального часу** (слідує за зима/літо), `LogonType Interactive`
(лише коли залогінений, без пароля), ліміт 1 год, `StartWhenAvailable=True`,
обмеження за батареєю зняті. Дія — `bash.exe -lc ".../refresh_local.sh"`.
Перевірити прогін: `Get-ScheduledTaskInfo -TaskName 'Hydra localization refresh'`
(`LastRunTime` / `LastTaskResult`, 0 = успіх) + хвіст `refresh_local.log`.

**Як догоняє пропуски.** `StartWhenAvailable=True` — це і є «догін пропущеного»:
пропущений тригер 15:00 не втрачається, задача підхопить його після входу в
систему (зазвичай ~1–10 хв після логіну). Якщо о 15:00 комп **спить** — будити
не буде (`WakeToRun=False`), відпрацює, коли прокинешся й залогінишся. Якщо комп
не вмикався 2 тижні — жодного «накопичення»: догоняється **лише останній
пропущений день**, один прогін при поверненні, далі звичайний розклад 15:00.
Увесь цей час 3 джерела стоять на останніх добрих даних, хмарний крон тримає
решту 11 свіжими, а guard гарантує, що фід не ламається. (Дефолтні обмеження
Windows `DisallowStartIfOnBatteries` / `StopIfGoingOnBatteries` зняті — прогін
іде незалежно від того, ноут на мережі чи на батареї.)

</details>
