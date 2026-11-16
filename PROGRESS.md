# Стан роботи

Цей файл — щоб продовжити з того самого місця після перерви. План — [PLAN.md](PLAN.md), рішення — [DECISIONS.md](DECISIONS.md).

## Як відновити роботу

1. `git status` і `git log --oneline -5` — що вже закомічено.
2. `node --test tests/` — усе має проходити.
3. Знайти нижче перший рядок зі статусом «у роботі» або «далі» і продовжити з нього.
4. Середовище навчання: `.venv\Scripts\python.exe` (якщо папки `.venv` немає —
   `powershell -ExecutionPolicy Bypass -File training\setup_env.ps1`). Дані — у `datasets/`, прогони — у `runs/` (обидві поза git).
5. Локальний перегляд: `node tools/serve.js` → http://localhost:8765 (у Claude: preview `berry-scanner`).

## Етапи

| Етап | Статус | Примітки |
|---|---|---|
| Огляд коду, план, рішення | зроблено | v0: 27 тестів проходять |
| Середовище навчання (`.venv`, PyTorch CUDA) | зроблено | torch 2.14.1+cu126, CUDA працює на GTX 1650 |
| A1 єдина таксономія | зроблено | `js/core/defaults.js`; старі записи мігрують при відкритті |
| A2 пліснява: оточення, текстура, «фон / інше» | зроблено | `classifyWhiteSpots` у `js/core/segment.js` |
| A3 ручна зона обведенням | зроблено | `roiPoly`; старий `roiRect` підтримується |
| A4 профілі ягід | зроблено | `BS.PROFILES`; лохина/малина/полуниця — експериментальні |
| C4 1–5 фото, якість фото, підказки | зроблено | `BS.photoQuality`, картка «Як знімати» |
| C1 режим перевірки «програма vs людина» | у роботі | пара й різниця на екрані результату є; накопичена похибка — в аналітиці (C3) |
| C3 аналітика, Excel/CSV/PDF | далі | |
| B1 таксономія і відповідність класів | далі | |
| B2 збір даних, DATA_SOURCES.md, data/custom | далі | |
| B3 підготовка даних | далі | |
| B4 навчання | далі | |
| B5 оцінка, EVALUATION.md | далі | |
| B6 ONNX у браузері, режими | далі | |
| C2 впевненість із сигналами моделі | далі | |
| B7 автовизначення виду ягоди | далі | |
| Підсумок, README | далі | |

## Журнал

- 2026-11-16: прочитано код v0, складено план. Диск C: майже повний (3,3 ГБ) — усе важке кладемо на D: у папку проєкту.
- 2026-11-16: етап A готовий (v0.2.0, алгоритм hsv-v1.0), 41 тест, перевірено в браузері 375×812. Режими аналізу вже йдуть через `BS.analyzer` (поки лише кольоровий).
- 2026-11-16 (зупинка через ліміт): етап A розгорнуто (коміт 3d33908). Етап B розпочато, НЕ завершено.

## Де зупинився (продовжувати звідси)

Зроблено в етапі B:
- `training/download.py` + `training/remote_zip.py` — завантажено 4 набори в `datasets/raw` (1,59 ГБ з 5 ГБ): fruits360, smartberry, raspberryset (600 фото), fruitscls. Маніфест: `datasets/downloads.json`.
- `training/taxonomy.py` (B1: таксономія й таблиця відповідності), `training/model.py` (MobileNetV3-small + FPN), `training/synth.py` (синтетичні лотки), `training/prepare.py` (зведення до одного формату) — написано, `prepare.py` ще НЕ запускався.

Відомі проблеми, які треба виправити першими:
1. У Fruits-360 клас «Blackberrie 2» — сині ягоди, «Raspberry 1» — фіолетові (такі самі у вихідних файлах, це не помилка читання). «Blackberrie 2» прибрати з `FRUITS360_CLASSES`/`MAPPING`; малину або перефарбувати у червоний (зсув відтінку), або брати ягоди малини з іншого джерела.
2. У `synth.py` забагато й завеликі бліки (`add_glare`): зменшити кількість і радіус.
3. RaspberrySet: `classes.txt` в архіві немає; номери класів у файлах 1 і 2 трапляються найчастіше — порядок визначає `raspberry_class_ids` (частота + «червоність»), результат перевірити очима.

Далі за планом: запустити `prepare.py` → написати `train.py` (CE + слабка втрата для фото з міткою на все зображення, AMP, batch 8–16, TORCH_HOME=.cache/torch) → `evaluate.py` + `tools/eval_color.js` (порівняння з кольоровим методом; у `BS.analyze` додати параметр масштабу для плиток) → `EVALUATION.md` → `export_onnx.py` (ONNX + квантизація) → `js/ml/model.js` (ONNX Runtime Web у `vendor/`, ліниве завантаження, кеш у sw.js, `BS.model.predict/combine/supported`) і перемикач режимів у налаштуваннях → `DATA_SOURCES.md`, `tools/autolabel.js` і `data/custom/README.md` → C3 (вкладка «Аналітика», CSV/Excel/PDF, накопичена похибка «програма vs людина») → C2, B7, README, підсумок.

Не використано (ліцензія NC або потрібен акаунт) — згадати в DATA_SOURCES.md і в підсумку: RaspGrade (HF, CC BY-NC), BlueberryDCM (Zenodo, CC BY-NC), Strawberry Disease Detection (Mendeley k2ptxmfjhj, CC BY-NC; оригінал Afzaal — Kaggle), Roboflow Universe «Blackberry ripness», Mendeley zysvgmxcyz (CC BY, 2,1 ГБ, порядок класів не перевірено — можна додати).
