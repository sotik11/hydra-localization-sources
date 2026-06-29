# hydra-localization-sources

Генераторы, собирающие JSON-фиды (формат `LocalizationFile`) для фан-локализаций
в [форке Hydra](https://github.com/sotik11/hydra). Каждый источник — модуль в
`generators/`, вывод — `data/<src>.json`, который раздаётся как сырой файл
(`raw.githubusercontent.com/.../data/<src>.json`) и добавляется в Hydra как
источник локализаций.

## Запуск

```bash
npm install
node generators/<src>.mjs        # один источник
bash regen_all.sh                # все: снапшот -> реген по порядку -> авто-откат при деградации
```

`regen_all.sh` сначала копирует каждую базу в `data/*.json.backup`, прогоняет
генераторы в порядке зависимостей (`revoiceai → playground → synthvoiceru`,
остальные после) и, если источник вернулся < 50 % от бэкапа, **восстанавливает
бэкап** — куцый/заблокированный прогон не затирает хорошие данные.

## Источники (14)

| источник | сайт | язык | заметка |
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
| mvo | rgmvo.ru | 🇷🇺 | студия, cloud |
| synthvoiceru | boosty.to/synthvoiceru | 🇷🇺 | нейро-студия |
| revoiceai | boosty.to/revoice | 🇷🇺 | нейро-студия |
| turkce-yama | turkce-yama.com | 🇹🇷 | агрегатор, browser-only (Cloudflare) |
| calypsoceviri | calypsoceviri.com | 🇹🇷 | студия, direct (Cloudflare) |

Общий сетевой слой — `lib/net.mjs` (ретраи + бэкофф на 429/5xx, пул,
`getTextCurl` для Cloudflare-сайтов, `formatBytes`/`normalizeSize`).

## Автообновление

`.github/workflows/regenerate.yml` — cron (раз в сутки) прогоняет всё и коммитит
свежие данные. **Оговорка:** часть сайтов блокирует дата-центровые IP GitHub —
по факту прогона 2026-06-29 не обновляются с раннера `tribogamer`,
`komunitni-preklady` и `magyaritasok` (отдают 403 / блок-страницу). Для них
срабатывает degradation-guard (остаются последние хорошие данные), а полный
рефреш делается локально с residential IP. Примечательно: два Cloudflare-сайта
`turkce-yama` и `calypsoceviri` через `getTextCurl` (системный curl + Schannel)
с раннера **проходят** — то есть дело не столько в Cloudflare как таковом,
сколько в политике конкретного сайта к IP/фингерпринту.

## Локальный авто-рефреш заблокированных источников

Три источника — `komunitni-preklady`, `magyaritasok`, `tribogamer` — режутся по
**дата-центровому IP GitHub** (подтверждено 2026-06-29: на раннере `0`, с домашнего
IP полные счётчики). Блок именно по IP, не по TLS-фингерпринту: `getTextCurl` на
раннере для них тоже даёт `0`. Поэтому их обновляет локально, с residential-IP:

```bash
bash refresh_local.sh   # pull --rebase -> реген 3 -> degradation guard -> commit/push только этих 3
```

- логика та же, что в `regen_all.sh` (снапшот + откат при деградации < 50 %);
- весь вывод дублируется в `refresh_local.log` (gitignored);
- старт и финиш (со счётчиками по источникам) уходят в **Windows-тосты** через
  `notify.ps1` (встроенный WinRT `ToastNotificationManager`, без сторонних модулей;
  запускается через `powershell.exe` 5.1);
- эталонные счётчики: **komunitni 619, magyaritasok 2050, tribogamer 475** (полный
  прогон ~26 мин, magyaritasok самый долгий);
- `*.sh` залочены на LF через `.gitattributes` — иначе CRLF-checkout ломает bash задачи.

### Запуск по расписанию (Windows Task Scheduler)

Задача **«Hydra localization refresh»**: ежедневно **15:00 локального времени**
(следует за зима/лето), `LogonType Interactive` (только когда залогинен, без пароля),
лимит 1 ч, `StartWhenAvailable=True`, ограничения по батарее сняты. Действие —
`bash.exe -lc "/c/temp/claude/hydra-localization-sources/refresh_local.sh"`.

Проверить прогон: `Get-ScheduledTaskInfo -TaskName 'Hydra localization refresh'`
(`LastRunTime` / `LastTaskResult`, 0 = успех) + хвост `refresh_local.log`.

### Поведение расписания (как оно догоняет пропуски)

**Включил комп после 15:00 (например, в 20:00) — отработает в тот день?**
Да. `StartWhenAvailable=True` — это и есть «догон пропущенного». Пропущенный триггер
15:00 не теряется: как войдёшь в систему, задача его подхватит и отработает тем же
вечером.

**Как быстро после старта?**
Считается не «после включения», а **после входа в систему** (задача «только когда
залогинен»). Windows запускает пропущенные задачи не мгновенно, а с небольшой
пачечной задержкой — обычно **в пределах ~1–10 минут после входа**. Если ты уже за
компом до 15:00 и не выключаешься — стартует ровно в 15:00. Если комп не выключен, а
**спит** в 15:00 — будить его задача не будет (`WakeToRun=False`), отработает, когда
проснётся и залогинишься.

**Комп не включался 2 недели?**
Никакого «накопления» и пачки прогонов разом. У ежедневного триггера догоняется
**только последний пропущенный день** — один прогон при возвращении (те же ~1–10 мин
после входа), дальше обычное расписание 15:00. Всё это время 3 источника стоят на
последних хороших данных, облачный крон держит остальные 11 свежими, а guard
гарантирует, что фид не ломается.

(Дефолтные ограничения Windows `DisallowStartIfOnBatteries` / `StopIfGoingOnBatteries`
сняты — прогон идёт независимо от того, на сети ноут или на батарее.)
