"""Єдина таксономія класів і таблиця відповідності класів відкритих наборів.

Це єдине джерело правди для навчання, оцінки й експорту. У браузері ті самі номери класів
(js/core/defaults.js: BS.CLASSES): 1 якісна, 2 недостигла, 3 пошкоджена/гнила, 4 пліснява, 5 домішки;
0 у моделі — фон (у браузері: «поза зоною» або «фон / інше»).
"""
from __future__ import annotations

CLASSES = ["background", "good", "unripe", "damaged", "mold", "debris"]
LABELS_UK = ["фон", "якісна", "недостигла", "пошкоджена / гнила", "пліснява", "домішки / стороннє"]
BACKGROUND, GOOD, UNRIPE, DAMAGED, MOLD, DEBRIS = range(6)
NUM_CLASSES = len(CLASSES)
IGNORE = 255          # піксель без розмітки: у втрату й метрики не входить
SPECIES = ["blackberry", "blueberry", "raspberry", "strawberry"]

# --- Відповідність класів наборів до єдиної таксономії ---------------------------------------
# kind: як набір використовується
#   sprite — окремі ягоди на білому тлі; з них складаються синтетичні лотки (піксельна розмітка відома точно)
#   dense  — піксельна (або зведена до піксельної) розмітка реального фото
#   weak   — відомо лише, що є на фото загалом (класифікаційний набір): present — що точно є, absent — чого точно немає
MAPPING = {
    "fruits360": {
        "kind": "sprite",
        "classes": {
            "Blackberrie 1": ("blackberry", GOOD),
            "Blackberrie half rippen 1": ("blackberry", UNRIPE),
            "Blackberrie not rippen 1": ("blackberry", UNRIPE),
            "Blueberry 1": ("blueberry", GOOD),
            "Raspberry 1": ("raspberry", GOOD),      # у наборі ці фото фіолетові: відтінок виправляється в synth.py
            "Strawberry 1": ("strawberry", GOOD),
        },
    },
    "fruitscls": {
        "kind": "sprite+dense",          # біле тло: ягода вирізається; частина фото йде в тест «біле тло без плісняви»
        "classes": {
            "fresh_strawberries_done": ("strawberry", GOOD),
            "rotten_strawberries_done": ("strawberry", DAMAGED),
        },
    },
    "raspberryset": {
        "kind": "dense",                 # рамки → еліпс у рамці = клас, край рамки = «не знаємо», решта = фон
        "species": "raspberry",
        # порядок класів у файлах YOLO перевіряється у prepare.py за classes.txt з архіву
        "classes": {
            "Ripe Berry": GOOD,
            "Unripe Berry": UNRIPE,
            "Bud": BACKGROUND,           # бутони й квітки — частини рослини; у лотку їх немає
            "Flower": BACKGROUND,
            "Damaged buds": BACKGROUND,
        },
    },
    "smartberry": {
        "kind": "weak",
        "species": "strawberry",
        "classes": {
            "ripe fruits": {"present": [GOOD], "absent": [MOLD, DAMAGED]},
            "unripe fruits": {"present": [UNRIPE], "absent": [MOLD, DAMAGED]},
            "fruit rot": {"present": [DAMAGED], "absent": []},
            "drought fruits": {"present": [DAMAGED], "absent": [MOLD]},
            "fruit powdery mildew": {"present": [MOLD], "absent": []},   # білий грибковий наліт на плоді
            "healthy leaves": {"present": [BACKGROUND], "absent": [GOOD, UNRIPE, DAMAGED, MOLD]},
        },
    },
    # data/custom: власні фото користувача; автопідказка розмітки кольоровим методом (tools/autolabel.js)
    "custom": {"kind": "dense", "classes": "як у єдиній таксономії"},
}


def mapping_table_markdown() -> str:
    """Таблиця відповідності для документації (DATA_SOURCES.md)."""
    rows = ["| Набір | Клас у наборі | Клас у єдиній таксономії | Як використовується |", "|---|---|---|---|"]
    use = {"sprite": "ягоди для синтетичних лотків", "sprite+dense": "ягоди для синтетичних лотків; тест на білому тлі",
           "dense": "піксельна розмітка", "weak": "мітка на все фото"}
    for name, m in MAPPING.items():
        if not isinstance(m["classes"], dict):
            continue
        for src, dst in m["classes"].items():
            if isinstance(dst, tuple):
                txt = f"{LABELS_UK[dst[1]]} ({dst[0]})"
            elif isinstance(dst, dict):
                txt = "є: " + ", ".join(LABELS_UK[c] for c in dst["present"])
                if dst["absent"]:
                    txt += "; немає: " + ", ".join(LABELS_UK[c] for c in dst["absent"])
            else:
                txt = LABELS_UK[dst]
            rows.append(f"| {name} | {src} | {txt} | {use[m['kind']]} |")
    return "\n".join(rows)


if __name__ == "__main__":
    print(mapping_table_markdown())
