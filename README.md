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
свежие данные. **Оговорка:** Cloudflare-сайты (tribogamer / turkce-yama /
calypsoceviri) могут отдавать 403 на дата-центровых IP GitHub — для них работает
тот же degradation-guard (остаются последние хорошие данные), полный рефреш этих
источников делается локально с residential IP.
