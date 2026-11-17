"""Зводить усі набори до одного формату: datasets/prepared/{train,val,test}/<ім'я>.jpg + <ім'я>.png + meta.jsonl.

  <ім'я>.png — карта класів єдиної таксономії (0..5), 255 = «не знаємо» (у втрату й метрики не входить);
  meta.jsonl — по рядку на зображення: джерело, вид ягоди, тип розмітки (dense / weak), ознаки для оцінки.

Масштаб зображень — як у фото лотка, зменшеного до 1024 px: ягода має діаметр приблизно 30–110 px.
Розбиття train/val/test — за вихідними фото (плитки одного фото не розходяться по різних частинах).

    .venv\\Scripts\\python.exe training\\prepare.py
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from synth import IMAGE_EXT, SpriteBank, cut_from_white, make_tray, split_of  # noqa: E402
from taxonomy import BACKGROUND, GOOD, IGNORE, MAPPING, UNRIPE  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "datasets" / "raw"
OUT = ROOT / "datasets" / "prepared"
CUSTOM = ROOT / "data" / "custom"


def hash_split(name: str, val: float = 0.15, test: float = 0.15) -> str:
    v = int(hashlib.md5(name.encode("utf-8")).hexdigest()[:8], 16) / 0xFFFFFFFF
    return "test" if v < test else "val" if v < test + val else "train"


def save(split: str, name: str, bgr: np.ndarray, lbl: np.ndarray, meta: dict, quality: int = 90) -> dict:
    d = OUT / split
    d.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(d / f"{name}.jpg"), bgr, [cv2.IMWRITE_JPEG_QUALITY, quality])
    cv2.imwrite(str(d / f"{name}.png"), lbl)
    return dict(meta, file=name, split=split, w=int(bgr.shape[1]), h=int(bgr.shape[0]))


def imread(path: Path) -> np.ndarray | None:
    data = np.fromfile(str(path), np.uint8)          # шляхи з кирилицею cv2.imread не читає
    return cv2.imdecode(data, cv2.IMREAD_COLOR) if data.size else None


# ---------------- синтетичні лотки ----------------
_bank = None


def _init_bank(split: str):
    global _bank
    _bank = SpriteBank(RAW, split, per_class=260, seed=1)


def _synth_one(args) -> dict:
    split, i, seed = args
    img, lbl, info = make_tray(_bank, seed)
    return save(split, f"synth_{i:05d}", img, lbl, dict(info, source="synth", kind="dense", synthetic=True), quality=92)


def do_synth(split: str, n: int, workers: int) -> list[dict]:
    base = {"train": 1_000_000, "val": 2_000_000, "test": 3_000_000}[split]
    with ProcessPoolExecutor(workers, initializer=_init_bank, initargs=(split,)) as ex:
        return list(ex.map(_synth_one, [(split, i, base + i) for i in range(n)], chunksize=16))


# ---------------- RaspberrySet: рамки YOLO ----------------
def raspberry_class_ids(folder: Path) -> dict[int, int]:
    """Номер класу в YOLO-файлах → клас єдиної таксономії. Порядок перевіряється, а не приймається на віру."""
    names = None
    for p in folder.rglob("classes.txt"):
        names = [s.strip() for s in p.read_text(encoding="utf-8").splitlines() if s.strip()]
    target = {k.lower(): v for k, v in MAPPING["raspberryset"]["classes"].items()}
    if names:
        return {i: target.get(n.lower(), BACKGROUND) for i, n in enumerate(names)}
    # classes.txt немає: відновлюємо за частотою й кольором. За описом набору недостиглих найбільше (29 тис. рамок),
    # стиглих найменше (463) і вони червоні.
    counts: dict[int, int] = {}
    red: dict[int, list[float]] = {}
    for txt in sorted(folder.rglob("*.txt"))[:400]:
        img = None
        for line in txt.read_text().splitlines():
            parts = line.split()
            if len(parts) != 5:
                continue
            c = int(parts[0])
            counts[c] = counts.get(c, 0) + 1
            if len(red.get(c, [])) < 150:
                if img is None:
                    img = next((imread(txt.with_suffix(e)) for e in IMAGE_EXT if txt.with_suffix(e).exists()), None)
                if img is None:
                    continue
                h, w = img.shape[:2]
                cx, cy, bw, bh = (float(v) for v in parts[1:])
                patch = img[int((cy - bh / 4) * h):int((cy + bh / 4) * h) + 1, int((cx - bw / 4) * w):int((cx + bw / 4) * w) + 1]
                if patch.size:
                    b, g, r = patch.reshape(-1, 3).mean(0)
                    red.setdefault(c, []).append(float(r - max(g, b)))
    unripe = max(counts, key=counts.get)
    redness = {c: float(np.mean(v)) for c, v in red.items() if c != unripe and v}
    ripe = max(redness, key=redness.get)
    print(f"    RaspberrySet: рамок за класами {counts}; «червоність» {{{', '.join(f'{c}: {v:.0f}' for c, v in redness.items())}}}")
    print(f"    → недостиглі = клас {unripe}, стиглі = клас {ripe}, решта (бутони, квітки) = фон")
    return {c: (UNRIPE if c == unripe else GOOD if c == ripe else BACKGROUND) for c in counts}


def do_raspberry(tile: int = 512, long_side: int = 1024) -> list[dict]:
    folder = RAW / "raspberryset"
    if not folder.exists():
        return []
    ids = raspberry_class_ids(folder)
    metas = []
    rs = np.random.RandomState(7)
    for txt in sorted(folder.rglob("*.txt")):
        if txt.name == "classes.txt":
            continue
        img = next((imread(txt.with_suffix(e)) for e in IMAGE_EXT if txt.with_suffix(e).exists()), None)
        if img is None:
            continue
        k = long_side / max(img.shape[:2])
        img = cv2.resize(img, None, fx=k, fy=k, interpolation=cv2.INTER_AREA)
        h, w = img.shape[:2]
        lbl = np.zeros((h, w), np.uint8)
        boxes = []
        for line in txt.read_text().splitlines():
            parts = line.split()
            if len(parts) == 5:
                boxes.append((ids.get(int(parts[0]), BACKGROUND), *(float(v) for v in parts[1:])))
        # спершу «не знаємо» на всю рамку, потім клас в еліпсі: край рамки лишається невизначеним
        for c, cx, cy, bw, bh in boxes:
            if c != BACKGROUND:
                cv2.rectangle(lbl, (int((cx - bw / 2) * w), int((cy - bh / 2) * h)), (int((cx + bw / 2) * w), int((cy + bh / 2) * h)), IGNORE, -1)
        for c, cx, cy, bw, bh in boxes:
            if c != BACKGROUND:
                cv2.ellipse(lbl, (int(cx * w), int(cy * h)), (max(1, int(bw * w * 0.36)), max(1, int(bh * h * 0.36))), 0, 0, 360, int(c), -1)
        split = hash_split(txt.stem)
        n = 0
        for y0 in range(0, h - tile + 1, tile):
            for x0 in range(0, w - tile + 1, tile):
                t_l = lbl[y0:y0 + tile, x0:x0 + tile]
                has = bool(((t_l > 0) & (t_l != IGNORE)).any())
                if not has and rs.rand() > 0.25:
                    continue                             # порожні плитки (саме листя) беремо лише частково
                metas.append(save(split, f"rasp_{txt.stem}_{n}", img[y0:y0 + tile, x0:x0 + tile], t_l,
                                  {"source": "raspberryset", "species": "raspberry", "kind": "dense", "synthetic": False, "origin": txt.stem}))
                n += 1
    return metas


# ---------------- Fruits Dataset for Classification: полуниця на білому тлі ----------------
def do_fruitscls(side: int = 256) -> list[dict]:
    folder = RAW / "fruitscls"
    metas = []
    for cls, (species, label) in MAPPING["fruitscls"]["classes"].items():
        files = sorted(p for d in folder.rglob(cls) if d.is_dir() for p in d.iterdir() if p.suffix.lower() in IMAGE_EXT)
        for i, p in enumerate(files):
            img = imread(p)
            if img is None:
                continue
            img = cv2.resize(img, (side, side), interpolation=cv2.INTER_AREA)
            alpha = cut_from_white(img)
            if alpha is None:
                continue
            lbl = np.zeros((side, side), np.uint8)
            lbl[alpha > 0.1] = IGNORE                     # розмитий край — «не знаємо»
            lbl[alpha > 0.6] = label
            # те саме розбиття, що й у SpriteBank: ягоди з тесту не потрапляють у навчальні синтетичні лотки
            metas.append(save(split_of(i, len(files)), f"fcls_{cls.split('_')[0]}_{i:04d}", img, lbl,
                              {"source": "fruitscls", "species": species, "kind": "dense", "synthetic": False, "white_bg": True, "image_class": int(label)}))
    return metas


# ---------------- SmartBerry: мітка на все фото ----------------
def do_smartberry(long_side: int = 512) -> list[dict]:
    folder = RAW / "smartberry"
    metas = []
    for d in sorted(p for p in folder.rglob("*") if p.is_dir()):
        rule = MAPPING["smartberry"]["classes"].get(d.name)
        if rule is None:
            continue
        part = "test" if "test" in [x.lower() for x in d.parts] else None
        for i, p in enumerate(sorted(q for q in d.iterdir() if q.suffix.lower() in IMAGE_EXT)):
            img = imread(p)
            if img is None:
                continue
            k = long_side / max(img.shape[:2])
            img = cv2.resize(img, None, fx=k, fy=k, interpolation=cv2.INTER_AREA)
            lbl = np.full(img.shape[:2], IGNORE, np.uint8)
            split = part or ("val" if hash_split(p.name, val=0.15, test=0.0) == "val" else "train")
            name = "sb_" + d.name.replace(" ", "-") + f"_{part or 'tr'}{i:04d}"
            metas.append(save(split, name, img, lbl, {"source": "smartberry", "species": "strawberry", "kind": "weak", "synthetic": False,
                                                      "image_class": d.name, "present": rule["present"], "absent": rule["absent"]}))
    return metas


# ---------------- data/custom: власні фото з автопідказкою розмітки ----------------
def do_custom(long_side: int = 1024, tile: int = 512) -> list[dict]:
    """Фото з data/custom, для яких є розмітка <ім'я>.label.png (її робить `node tools/autolabel.js`, потім можна виправити)."""
    metas = []
    if not CUSTOM.exists():
        return metas
    for p in sorted(q for q in CUSTOM.rglob("*") if q.suffix.lower() in (".jpg", ".jpeg") and ".label." not in q.name and ".preview." not in q.name):
        lab_path = p.with_name(p.stem + ".label.png")
        img = imread(p)
        if img is None or not lab_path.exists():
            continue
        lbl = cv2.imdecode(np.fromfile(str(lab_path), np.uint8), cv2.IMREAD_GRAYSCALE)
        k = long_side / max(img.shape[:2])
        img = cv2.resize(img, None, fx=k, fy=k, interpolation=cv2.INTER_AREA)
        lbl = cv2.resize(lbl, (img.shape[1], img.shape[0]), interpolation=cv2.INTER_NEAREST)
        h, w = img.shape[:2]
        n = 0
        for y0 in list(range(0, max(1, h - tile + 1), tile // 2)):
            for x0 in list(range(0, max(1, w - tile + 1), tile // 2)):
                metas.append(save("train", f"custom_{p.stem}_{n}", img[y0:y0 + tile, x0:x0 + tile], lbl[y0:y0 + tile, x0:x0 + tile],
                                  {"source": "custom", "species": p.parent.name if p.parent.name in ("blueberry", "raspberry", "strawberry") else "blackberry", "kind": "dense", "synthetic": False, "origin": p.name}))
                n += 1
    return metas


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--synth-train", type=int, default=5000)
    ap.add_argument("--synth-val", type=int, default=300)
    ap.add_argument("--synth-test", type=int, default=600)
    ap.add_argument("--workers", type=int, default=6)
    a = ap.parse_args()

    if OUT.exists():
        shutil.rmtree(OUT)                               # проміжні файли: щоразу будуються наново
    metas: list[dict] = []
    for name, fn in (("RaspberrySet", do_raspberry), ("Fruits Dataset for Classification", do_fruitscls), ("SmartBerry", do_smartberry), ("data/custom", do_custom)):
        got = fn()
        print(f"{name}: {len(got)} зображень")
        metas += got
    for split, n in (("train", a.synth_train), ("val", a.synth_val), ("test", a.synth_test)):
        got = do_synth(split, n, a.workers)
        print(f"синтетичні лотки, {split}: {len(got)}")
        metas += got

    for split in ("train", "val", "test"):
        rows = [m for m in metas if m["split"] == split]
        with open(OUT / split / "meta.jsonl", "w", encoding="utf-8") as f:
            for m in rows:
                f.write(json.dumps(m, ensure_ascii=False) + "\n")
        by: dict[str, int] = {}
        for m in rows:
            by[m["source"]] = by.get(m["source"], 0) + 1
        print(f"{split}: {len(rows)} зображень {by}")


if __name__ == "__main__":
    main()
