"""Завантаження відкритих наборів даних у ./datasets/raw (поза git).

Усі джерела качаються БЕЗ реєстрації й ключів. Для кожного записано ліцензію й атрибуцію (див. DATA_SOURCES.md).
Перед кожним завантаженням перевіряється вільне місце на диску і загальний ліміт (типово 5 ГБ).
З великих архівів беруться лише потрібні папки — частинами через HTTP Range, без завантаження цілого файлу.

    .venv\\Scripts\\python.exe training\\download.py            # усе
    .venv\\Scripts\\python.exe training\\download.py --only fruits360 smartberry
    .venv\\Scripts\\python.exe training\\download.py --list     # лише показати джерела
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from remote_zip import open_remote_zip  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "datasets" / "raw"
MANIFEST = ROOT / "datasets" / "downloads.json"
IMAGE_EXT = (".jpg", ".jpeg", ".png", ".bmp", ".webp")

# Класи Fruits-360, які нам потрібні (ягоди чотирьох профілів).
FRUITS360_CLASSES = (
    "Blackberrie 1", "Blackberrie half rippen 1", "Blackberrie not rippen 1",
    "Blueberry 1", "Raspberry 1", "Strawberry 1",
)
SMARTBERRY_CLASSES = ("ripe fruits", "unripe fruits", "fruit rot", "fruit powdery mildew", "drought fruits", "healthy leaves")

SOURCES = {
    "fruits360": {
        "title": "Fruits-360 (100x100), версія 2025.03.11.0",
        "url": "https://data.mendeley.com/public-files/datasets/rp73yg93n8/files/94414e4e-b8b5-4b48-8190-154d150e0899/file_downloaded",
        "page": "https://data.mendeley.com/datasets/rp73yg93n8/4",
        "license": "CC BY 4.0",
        "attribution": "Mihai Oltean, Fruits-360 dataset, Mendeley Data, V4, doi:10.17632/rp73yg93n8.4",
        "expected_mb": 50,
        "keep": lambda name: name.lower().endswith(IMAGE_EXT) and name.split("/")[-2] in FRUITS360_CLASSES,
    },
    "smartberry": {
        "title": "SmartBerry: Strawberry Field Image Dataset from Nigeria",
        "url": "https://zenodo.org/api/records/22056372/files/SmartBerry%20Dataset.zip/content",
        "page": "https://zenodo.org/records/22056372",
        "license": "CC BY 4.0",
        "attribution": "Isibor Kennedy Ihianle, SmartBerry: Strawberry Field Image Dataset from Nigeria, Zenodo, doi:10.5281/zenodo.22056372",
        "expected_mb": 330,
        "keep": lambda name: name.lower().endswith(IMAGE_EXT) and name.split("/")[-2] in SMARTBERRY_CLASSES,
    },
    "raspberryset": {
        "title": "RaspberrySet: Dataset of Annotated Raspberry Images for Object Detection",
        "url": "https://zenodo.org/api/records/7014728/files/RaspberrySet.zip/content",
        "page": "https://zenodo.org/records/7014728",
        "license": "CC BY 4.0",
        "attribution": "S. Strautiņa, I. Kalniņa, E. Kaufmane, K. Sudars, I. Namatēvs, A. Ņikuļins, RaspberrySet, Zenodo, doi:10.5281/zenodo.7014728",
        "expected_mb": 480,
        # архів 1,5 ГБ; беремо перші ~600 пар «фото + розмітка» у порядку архіву (читання поспіль, без зайвих запитів)
        "keep": lambda name: name.lower().endswith(IMAGE_EXT + (".txt",)),
        "max_images": 600,
    },
    "fruitscls": {
        "title": "Fruits Dataset for Classification (strawberries, peaches, pomegranates: fresh / rotten)",
        "url": "https://data.mendeley.com/public-files/datasets/rg254yr63x/files/9d597a43-3d7a-4308-9d68-93ee49fa8b3f/file_downloaded",
        "page": "https://data.mendeley.com/datasets/rg254yr63x/1",
        "license": "Apache-2.0",
        "attribution": "GTS, Fruits Dataset for Classification, Mendeley Data, V1, doi:10.17632/rg254yr63x.1",
        "expected_mb": 6,
        "keep": lambda name: name.lower().endswith(IMAGE_EXT) and "strawberr" in name.lower(),
    },
}


def load_manifest() -> dict:
    if MANIFEST.exists():
        return json.loads(MANIFEST.read_text(encoding="utf-8"))
    return {"limit_gb": 5.0, "sources": {}}


def save_manifest(m: dict) -> None:
    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST.write_text(json.dumps(m, ensure_ascii=False, indent=1), encoding="utf-8")


def downloaded_gb(m: dict) -> float:
    return sum(s.get("network_mb", 0) for s in m["sources"].values()) / 1024


def fetch(key: str, limit_gb: float, force: bool = False) -> None:
    src = SOURCES[key]
    m = load_manifest()
    if key in m["sources"] and m["sources"][key].get("done") and not force:
        print(f"[{key}] уже завантажено: {m['sources'][key]['files']} файлів")
        return

    free_gb = shutil.disk_usage(ROOT).free / 1024 ** 3
    used_gb = downloaded_gb(m)
    need_gb = src["expected_mb"] / 1024
    print(f"[{key}] {src['title']}\n    ліцензія: {src['license']} · очікуваний розмір ~{src['expected_mb']} МБ")
    print(f"    вільно на диску: {free_gb:.1f} ГБ · уже завантажено: {used_gb:.2f} ГБ з ліміту {limit_gb:.1f} ГБ")
    if free_gb < need_gb * 2 + 2:
        raise SystemExit(f"[{key}] замало місця на диску ({free_gb:.1f} ГБ) — зупиняюсь")
    if used_gb + need_gb > limit_gb:
        raise SystemExit(f"[{key}] перевищено б ліміт завантажень {limit_gb} ГБ — зупиняюсь")

    out = RAW / key
    out.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    z, raw = open_remote_zip(src["url"])
    names = [i for i in z.infolist() if not i.is_dir() and src["keep"](i.filename)]
    names.sort(key=lambda i: i.header_offset)  # у порядку архіву: сусідні файли беруться одним запитом
    if src.get("max_images"):
        stems, picked = [], []
        for i in names:
            stem = i.filename.rsplit(".", 1)[0]
            if stem not in stems:
                if len(stems) >= src["max_images"]:
                    continue
                stems.append(stem)
            picked.append(i)
        keep_stems = set(stems)
        names = [i for i in names if i.filename.rsplit(".", 1)[0] in keep_stems]
    total = sum(i.file_size for i in names)
    print(f"    файлів до завантаження: {len(names)} ({total / 1e6:.0f} МБ у розпакованому вигляді)")
    done = 0
    for n, info in enumerate(names, 1):
        target = out / info.filename
        # захист від «zip slip»: шлях має лишатися всередині нашої папки
        if out.resolve() not in target.resolve().parents:
            continue
        if not target.exists() or target.stat().st_size != info.file_size:
            target.parent.mkdir(parents=True, exist_ok=True)
            with z.open(info) as src_f, open(target, "wb") as dst_f:
                shutil.copyfileobj(src_f, dst_f, 1024 * 1024)
        done += 1
        if n % 200 == 0 or n == len(names):
            print(f"    {n}/{len(names)} · з мережі {raw.bytes_fetched / 1e6:.0f} МБ · {time.time() - t0:.0f} с", flush=True)
        if raw.bytes_fetched / 1024 ** 3 + used_gb > limit_gb:
            raise SystemExit(f"[{key}] досягнуто ліміту {limit_gb} ГБ — зупиняюсь")
    m = load_manifest()
    m["limit_gb"] = limit_gb
    m["sources"][key] = {
        "done": True, "title": src["title"], "page": src["page"], "license": src["license"], "attribution": src["attribution"],
        "files": done, "unpacked_mb": round(total / 1e6, 1), "network_mb": round(raw.bytes_fetched / 1e6, 1),
        "downloaded_at": time.strftime("%Y-%m-%d %H:%M"),
    }
    save_manifest(m)
    print(f"[{key}] готово: {done} файлів, з мережі {raw.bytes_fetched / 1e6:.0f} МБ")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--only", nargs="*", choices=sorted(SOURCES), help="лише ці джерела")
    ap.add_argument("--limit-gb", type=float, default=5.0, help="загальний ліміт завантажень, ГБ")
    ap.add_argument("--force", action="store_true", help="завантажити ще раз")
    ap.add_argument("--list", action="store_true", help="показати джерела й вийти")
    a = ap.parse_args()
    if a.list:
        for k, s in SOURCES.items():
            print(f"{k:13} {s['license']:11} ~{s['expected_mb']:>4} МБ  {s['page']}\n{'':13} {s['title']}")
        return
    for key in a.only or list(SOURCES):
        fetch(key, a.limit_gb, a.force)
    print(f"Разом завантажено з мережі: {downloaded_gb(load_manifest()):.2f} ГБ")


if __name__ == "__main__":
    main()
