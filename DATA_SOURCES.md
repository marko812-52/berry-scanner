# Джерела даних

Усі набори нижче завантажено **без реєстрації й ключів** скриптом `training/download.py` у `datasets/raw/` (поза git і поза деплоєм).
Ліміт завантажень — 5 ГБ, використано 1,59 ГБ. Перед кожним завантаженням скрипт перевіряє вільне місце на диску.
З великих архівів беруться лише потрібні папки (частинами, через HTTP Range), тому з мережі качається менше, ніж розмір архіву.
Точний журнал — `datasets/downloads.json`.

## Використані набори

| Набір | Що взято | Ліцензія | Атрибуція |
|---|---|---|---|
| [Fruits-360](https://data.mendeley.com/datasets/rp73yg93n8/4) (версія 2025.03.11.0, 100×100) | класи ожини (стигла, напівстигла, недостигла), лохини, малини, полуниці — ~3,6 тис. фото окремих ягід на білому тлі | CC BY 4.0 | Mihai Oltean, *Fruits-360 dataset*, Mendeley Data, V4, doi:10.17632/rp73yg93n8.4 |
| [SmartBerry](https://zenodo.org/records/22056372) | фото полуниці в полі: стиглі, недостиглі, гниль, борошниста роса (білий грибковий наліт), посуха, здорове листя — 696 фото | CC BY 4.0 | Isibor Kennedy Ihianle, *SmartBerry: Strawberry Field Image Dataset from Nigeria*, Zenodo, doi:10.5281/zenodo.22056372 |
| [RaspberrySet](https://zenodo.org/records/7014728) | перші 600 фото малини на кущі з рамками (стиглі, недостиглі, бутони, квітки) | CC BY 4.0 | S. Strautiņa, I. Kalniņa, E. Kaufmane, K. Sudars, I. Namatēvs, A. Ņikuļins, *RaspberrySet: Dataset of Annotated Raspberry Images for Object Detection*, Zenodo, doi:10.5281/zenodo.7014728 |
| [Fruits Dataset for Classification](https://data.mendeley.com/datasets/rg254yr63x/1) | свіжа й гнила полуниця на білому тлі — 501 фото | Apache-2.0 | GTS, *Fruits Dataset for Classification*, Mendeley Data, V1, doi:10.17632/rg254yr63x.1 |

Особливості, які довелося врахувати:

- **Fruits-360:** клас «Blackberrie 2» — насправді сині ягоди, тож він не використовується. Фото малини мають фіолетовий відтінок,
  тому при вирізанні відтінок зсувається до червоного; це виправлення кольору, розмітку воно не змінює.
- **RaspberrySet:** у архіві немає файлу з назвами класів. Номери класів відновлено за частотою (недостиглих найбільше,
  як в описі набору) і за кольором (стиглі — найчервоніші); результат друкує `training/prepare.py`.
  Рамки зведено до піксельної розмітки так: еліпс у рамці — клас, решта рамки — «не знаємо», поза рамками — фон.
- **SmartBerry:** розмітка лише на все фото, тому використовується як «слабка» мітка (див. `training/train.py`).

## Відповідність класів єдиній таксономії

Єдина таксономія: 0 фон, 1 якісна, 2 недостигла, 3 пошкоджена / гнила, 4 пліснява, 5 домішки / стороннє
(`training/taxonomy.py`, у браузері — `BS.CLASSES`).

| Набір | Клас у наборі | Клас у єдиній таксономії | Як використовується |
|---|---|---|---|
| fruits360 | Blackberrie 1 | якісна (ожина) | ягоди для синтетичних лотків |
| fruits360 | Blackberrie half rippen 1 | недостигла (ожина) | ягоди для синтетичних лотків |
| fruits360 | Blackberrie not rippen 1 | недостигла (ожина) | ягоди для синтетичних лотків |
| fruits360 | Blueberry 1 | якісна (лохина) | ягоди для синтетичних лотків |
| fruits360 | Raspberry 1 | якісна (малина) | ягоди для синтетичних лотків |
| fruits360 | Strawberry 1 | якісна (полуниця) | ягоди для синтетичних лотків |
| fruitscls | fresh_strawberries_done | якісна (полуниця) | ягоди для синтетичних лотків; тест «біле тло ≠ пліснява» |
| fruitscls | rotten_strawberries_done | пошкоджена / гнила (полуниця) | ягоди для синтетичних лотків; тест на білому тлі |
| raspberryset | Ripe Berry | якісна | піксельна розмітка |
| raspberryset | Unripe Berry | недостигла | піксельна розмітка |
| raspberryset | Bud, Flower, Damaged buds | фон | піксельна розмітка |
| smartberry | ripe fruits | є якісна; немає плісняви й пошкоджених | мітка на все фото |
| smartberry | unripe fruits | є недостигла; немає плісняви й пошкоджених | мітка на все фото |
| smartberry | fruit rot | є пошкоджена / гнила | мітка на все фото |
| smartberry | drought fruits | є пошкоджена / гнила; немає плісняви | мітка на все фото |
| smartberry | fruit powdery mildew | є пліснява | мітка на все фото |
| smartberry | healthy leaves | лише фон | мітка на все фото |
| data/custom | власні фото підприємства | автопідказка кольоровим методом (`tools/autolabel.js`) | піксельна розмітка після перевірки людиною |

## Синтетичні лотки

Відкритого набору «лоток свіжої ожини з пліснявою» з розміткою немає. Тому `training/synth.py` складає сцени з вирізаних
ягід (Fruits-360, Fruits Dataset for Classification) і домальовує пліснява (нерівні м'які плями), бліки, листя й плодоніжки,
білі папірці, стіни, лотки, тіні, відтінок лампи, розмиття, JPEG-стиснення. Розмітка таких сцен точна, але самі сцени
відрізняються від справжніх лотків, тому метрики на них **оптимістичні** (див. EVALUATION.md).
Ягоди для навчальних, перевірочних і тестових сцен беруться з різних частин наборів.

## Не використано

| Набір | Причина | Що зробити, щоб додати |
|---|---|---|
| [Roboflow Universe: Blackberry ripness](https://universe.roboflow.com/workiee/blackberry-ripness) та інші набори ожини й плісняви полуниці на Roboflow | потрібен акаунт | увійти на universe.roboflow.com → Download Dataset → формат YOLO → розпакувати в `datasets/raw/roboflow-<назва>/` і дописати відповідність у `training/taxonomy.py` |
| Strawberry Disease Detection (Afzaal et al., оригінал на Kaggle) | потрібен акаунт Kaggle | увійти на kaggle.com → завантажити архів → розпакувати в `datasets/raw/` |
| [Strawberry Disease Detection Dataset with Hybrid Data Augmentation](https://data.mendeley.com/datasets/k2ptxmfjhj) (Mendeley, є клас Gray Mold) | ліцензія CC BY-NC 4.0 (лише некомерційне використання) | можна додати, якщо демо для підприємства вважається некомерційним — рішення за власником |
| [RaspGrade](https://huggingface.co/datasets/FBK-TeV/RaspGrade) (малина на конвеєрі, 5 класів якості) | ліцензія CC BY-NC 4.0 | як вище |
| [BlueberryDCM](https://zenodo.org/records/14002517) (лохина: стигла / нестигла) | ліцензія CC BY-NC 4.0 | як вище |
| [Ripening stages of strawberries and avocados](https://data.mendeley.com/datasets/zysvgmxcyz) | CC BY 4.0, але 2,1 ГБ фото по 5 МБ і нерозібраний порядок класів; відкладено, бо полуниця — не основна ягода | `training/download.py`: додати джерело, якщо знадобиться більше реальної полуниці |
