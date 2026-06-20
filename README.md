# hydra-localization-sources

Генераторы, собирающие JSON-фиды (формат LocalizationFile) для фан-локализаций Hydra.
Каждый источник = модуль в generators/, вывод = data/<src>.json (хостится через raw.githubusercontent).

## Запуск
- npm run gen:mvo  -> data/mvo.json

## Источники
- mvo: Mechanics VoiceOver (rgmvo.ru) — каталог /api/games/all + парс страниц игр; зеркала Яндекс/Google/MediaFire, матч по названию.
