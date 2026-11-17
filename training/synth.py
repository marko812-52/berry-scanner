"""Синтетичні «лотки з ягодами» з точною піксельною розміткою.

Навіщо. Відкритих наборів «лоток свіжої ягоди з пліснявою» з розміткою немає. Тому сцени складаються з
реальних фото окремих ягід (Fruits-360, Fruits Dataset for Classification), а пліснява, бліки, домішки,
папірці, стіни й лотки домальовуються процедурно. Це наближення: реальні лотки виглядають інакше,
і метрики на таких сценах оптимістичні (див. EVALUATION.md).
"""
from __future__ import annotations

import random
from pathlib import Path

import cv2
import numpy as np

from taxonomy import BACKGROUND, DAMAGED, DEBRIS, GOOD, MAPPING, MOLD, SPECIES, UNRIPE

IMAGE_EXT = (".jpg", ".jpeg", ".png")


# ---------------------------------------------------------------------------------------------
# Ягоди-«спрайти»: фото однієї ягоди на білому тлі → колір + маска
# ---------------------------------------------------------------------------------------------
def cut_from_white(bgr: np.ndarray) -> np.ndarray | None:
    """Маска об'єкта на білому тлі (0..1) або None, якщо вирізати не вдалося.

    Фон — світлі ненасичені пікселі (біле тло й сіра тінь), зв'язані з краєм кадру. Звичайна заливка від країв
    «просочується» через плавну тінь і відблиск усередину ягоди, тому вона тут не годиться.
    """
    h, w = bgr.shape[:2]
    hsv = cv2.cvtColor(cv2.GaussianBlur(bgr, (3, 3), 0), cv2.COLOR_BGR2HSV)
    cand = ((hsv[..., 1] < 45) & (hsv[..., 2] > 110)).astype(np.uint8)
    _, lab = cv2.connectedComponents(cand, connectivity=4)
    border = set(np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))) - {0}
    fg = (~np.isin(lab, list(border))).astype(np.uint8)
    fg = cv2.morphologyEx(fg, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    n, lab, stats, _ = cv2.connectedComponentsWithStats(fg, 8)
    if n < 2:
        return None
    k = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    fg = (lab == k).astype(np.uint8)
    # дірки всередині (блики на ягоді) — теж ягода
    inv = (1 - fg).astype(np.uint8)
    _, lab2 = cv2.connectedComponents(inv, connectivity=4)
    edge = set(np.unique(np.concatenate([lab2[0], lab2[-1], lab2[:, 0], lab2[:, -1]])))
    fg[(~np.isin(lab2, list(edge))) & (inv > 0)] = 1
    area = float(fg.sum()) / (h * w)
    if area < 0.08 or area > 0.97:
        return None
    fg = cv2.erode(fg, np.ones((3, 3), np.uint8))
    return cv2.GaussianBlur(fg.astype(np.float32), (0, 0), 0.8)


def crop_to_mask(bgr: np.ndarray, alpha: np.ndarray, size: int = 96) -> tuple[np.ndarray, np.ndarray]:
    ys, xs = np.where(alpha > 0.5)
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    bgr, alpha = bgr[y0:y1, x0:x1], alpha[y0:y1, x0:x1]
    k = size / max(bgr.shape[:2])
    if k < 1:
        bgr = cv2.resize(bgr, None, fx=k, fy=k, interpolation=cv2.INTER_AREA)
        alpha = cv2.resize(alpha, (bgr.shape[1], bgr.shape[0]), interpolation=cv2.INTER_AREA)
    return bgr, alpha


def split_of(index: int, total: int) -> str:
    """Суцільні блоки кадрів: 70 % навчання, 15 % перевірка, 15 % тест."""
    f = index / max(1, total)
    return "train" if f < 0.70 else "val" if f < 0.85 else "test"


class SpriteBank:
    """Вирізані ягоди, згруповані за (вид, клас), для одного з розбиттів."""

    def __init__(self, raw_root: Path, split: str, per_class: int = 260, seed: int = 0):
        self.items: dict[tuple[str, int], list[tuple[np.ndarray, np.ndarray]]] = {}
        rng = random.Random(seed)
        groups: dict[tuple[str, int], list[Path]] = {}
        f360 = raw_root / "fruits360"
        for cls, (species, label) in MAPPING["fruits360"]["classes"].items():
            files = sorted(p for d in f360.rglob(cls) if d.is_dir() for p in d.iterdir() if p.suffix.lower() in IMAGE_EXT)
            groups.setdefault((species, label), []).extend(p for i, p in enumerate(files) if split_of(i, len(files)) == split)
        fcls = raw_root / "fruitscls"
        for cls, (species, label) in MAPPING["fruitscls"]["classes"].items():
            files = sorted(p for d in fcls.rglob(cls) if d.is_dir() for p in d.iterdir() if p.suffix.lower() in IMAGE_EXT)
            groups.setdefault((species, label), []).extend(p for i, p in enumerate(files) if split_of(i, len(files)) == split)
        for key, files in groups.items():
            rng.shuffle(files)
            out = []
            for p in files:
                if len(out) >= per_class:
                    break
                bgr = cv2.imread(str(p), cv2.IMREAD_COLOR)
                if bgr is None:
                    continue
                alpha = cut_from_white(bgr)
                if alpha is None:
                    continue
                if key[0] == "raspberry" and "fruits360" in p.parts:
                    bgr = fix_purple(bgr)
                out.append(crop_to_mask(bgr, alpha))
            if out:
                self.items[key] = out

    def summary(self) -> dict:
        return {f"{k[0]}/{k[1]}": len(v) for k, v in self.items.items()}

    def get(self, rng: random.Random, species: str, label: int):
        """Ягода потрібного виду й класу. Якщо реальних «недостиглих» немає — перефарбована якісна."""
        if (species, label) in self.items:
            bgr, a = rng.choice(self.items[(species, label)])
            if species == "blackberry" and label == GOOD and rng.random() < 0.75:
                return tint_blackberry(bgr, rng), a
            return bgr.copy(), a
        bgr, a = rng.choice(self.items[(species, GOOD)])
        if label == UNRIPE:
            return recolor_unripe(bgr, species, rng), a
        return bgr.copy(), a


def tint_blackberry(bgr: np.ndarray, rng: random.Random) -> np.ndarray:
    """Стигла ожина в лотку має пурпуровий відблиск і світліша за майже чорні фото Fruits-360
    (виміряно: на реальному фото 54 % кольорових пікселів мають відтінок 280–360°, медіана яскравості 0,13;
    у Fruits-360 — 2 % і 0,06). Підфарбовуємо в цих межах, клас лишається «якісна»."""
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV).astype(np.float32)          # H 0..180
    hue = rng.uniform(140, 178)                                             # 280..356°
    jitter = np.random.RandomState(rng.randint(0, 2 ** 31 - 1)).uniform(-6, 6, hsv.shape[:2])
    share = rng.uniform(0.5, 0.95)                                          # частка пікселів із відтінком
    mask = np.random.RandomState(rng.randint(0, 2 ** 31 - 1)).rand(*hsv.shape[:2]) < share
    mask = cv2.GaussianBlur(mask.astype(np.float32), (0, 0), 2.0) > 0.5
    hsv[..., 0] = np.where(mask, (hue + jitter) % 180, hsv[..., 0])
    hsv[..., 1] = np.clip(hsv[..., 1] * rng.uniform(0.35, 0.75), 0, 255)
    hsv[..., 2] = np.clip(hsv[..., 2] * rng.uniform(1.6, 2.8), 0, 255)
    return cv2.cvtColor(hsv.astype(np.uint8), cv2.COLOR_HSV2BGR)


def fix_purple(bgr: np.ndarray) -> np.ndarray:
    """Малина у Fruits-360 знята з фіолетовим відтінком. Зсуваємо відтінок до червоного (це виправлення кольору, не розмітки)."""
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV).astype(np.int32)
    colored = hsv[..., 1] > 40
    if not colored.any():
        return bgr
    med = int(np.median(hsv[..., 0][colored]))
    hsv[..., 0] = (hsv[..., 0] + (176 - med)) % 180          # медіанний відтінок → 352°
    hsv[..., 1] = np.clip(hsv[..., 1] * 1.15, 0, 255)
    return cv2.cvtColor(hsv.astype(np.uint8), cv2.COLOR_HSV2BGR)


def recolor_unripe(bgr: np.ndarray, species: str, rng: random.Random) -> np.ndarray:
    """Грубе наближення недостиглої ягоди: змінюємо відтінок, насиченість і яскравість стиглої."""
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV).astype(np.float32)   # H: 0..180
    if species == "raspberry":
        hsv[..., 0] = rng.uniform(12, 38)            # жовтувато-зелені, блідо-помаранчеві
        hsv[..., 1] *= rng.uniform(0.35, 0.7)
        hsv[..., 2] = np.clip(hsv[..., 2] * rng.uniform(1.15, 1.5) + 20, 0, 255)
    elif species == "strawberry":
        if rng.random() < 0.6:                       # блідо-білі з рожевим
            hsv[..., 1] *= rng.uniform(0.15, 0.4)
        else:                                        # зеленувато-білі
            hsv[..., 0] = rng.uniform(25, 45)
            hsv[..., 1] *= rng.uniform(0.3, 0.5)
        hsv[..., 2] = np.clip(hsv[..., 2] * rng.uniform(1.1, 1.4) + 25, 0, 255)
    else:                                            # лохина: зелені або рожево-червоні
        hsv[..., 0] = rng.uniform(35, 55) if rng.random() < 0.6 else rng.uniform(160, 175)
        hsv[..., 1] = np.clip(hsv[..., 1] * 0.6 + rng.uniform(60, 110), 0, 255)
        hsv[..., 2] = np.clip(hsv[..., 2] * rng.uniform(1.5, 2.2) + 30, 0, 255)
    return cv2.cvtColor(hsv.astype(np.uint8), cv2.COLOR_HSV2BGR)


# ---------------------------------------------------------------------------------------------
# Складання сцени
# ---------------------------------------------------------------------------------------------
PLASTIC = [(170, 120, 40), (150, 140, 30), (60, 140, 60), (40, 40, 180), (40, 40, 40), (200, 200, 200), (235, 235, 235), (90, 160, 200)]
DARK_BASE = {"blackberry": (22, 12, 18), "blueberry": (40, 22, 18), "raspberry": (20, 12, 70), "strawberry": (18, 14, 80)}
BRIGHT = {"blackberry": (0.35, 0.95), "blueberry": (0.55, 1.1), "raspberry": (0.7, 1.15), "strawberry": (0.7, 1.15)}


def smooth_noise(h: int, w: int, sigma: float, rs: np.random.RandomState) -> np.ndarray:
    n = rs.rand(h, w).astype(np.float32)
    n = cv2.GaussianBlur(n, (0, 0), sigma)
    return (n - n.min()) / max(1e-6, n.max() - n.min())


def background(size: int, rng: random.Random, rs: np.random.RandomState) -> np.ndarray:
    kind = rng.choice(["wall", "wall", "plastic", "table", "steel"])
    if kind == "wall":
        v = rng.randint(170, 250)
        base = np.array([v + rng.randint(-8, 8), v + rng.randint(-6, 6), v + rng.randint(-8, 8)], np.float32)
    elif kind == "plastic":
        base = np.array(rng.choice(PLASTIC), np.float32) + rs.randint(-15, 15, 3)
    elif kind == "table":
        base = np.array([rng.randint(60, 120), rng.randint(90, 150), rng.randint(120, 190)], np.float32)
    else:
        v = rng.randint(110, 190)
        base = np.array([v + 6, v, v - 4], np.float32)
    img = np.ones((size, size, 3), np.float32) * base
    img *= (0.85 + 0.3 * smooth_noise(size, size, size / 3, rs))[..., None]
    if kind in ("table", "steel"):
        img += (smooth_noise(size, size, 1.2, rs)[..., None] - 0.5) * 30
    if kind == "wall" and rng.random() < 0.5:        # шви плитки
        step = rng.randint(90, 260)
        for x in range(rng.randint(0, step), size, step):
            cv2.line(img, (x, 0), (x + rng.randint(-40, 40), size), tuple(float(c) * 0.8 for c in base), rng.randint(1, 3))
    if rng.random() < 0.35:                          # ребра лотка
        col = np.array(rng.choice(PLASTIC), np.float32)
        x0, step, wd = rng.randint(0, size // 2), rng.randint(10, 22), rng.randint(4, 10)
        y0, y1 = sorted((rng.randint(0, size), rng.randint(0, size)))
        for x in range(x0, min(size, x0 + rng.randint(80, 260)), step):
            cv2.rectangle(img, (x, y0), (x + wd, max(y1, y0 + 60)), tuple(float(c) for c in col), -1)
    return np.clip(img, 0, 255)


def tray_polygon(size: int, rng: random.Random) -> np.ndarray:
    if rng.random() < 0.4:
        return np.array([[-10, -10], [size + 10, -10], [size + 10, size + 10], [-10, size + 10]], np.int32)
    m = lambda lo, hi: rng.randint(int(size * lo), int(size * hi))
    pts = [[m(0.0, 0.35), m(0.0, 0.35)], [m(0.65, 1.0), m(0.0, 0.35)], [m(0.65, 1.0), m(0.65, 1.0)], [m(0.0, 0.35), m(0.65, 1.0)]]
    k = rng.randint(0, 3)                            # одну-дві сторони притискаємо до краю кадру
    if k == 0: pts[0][0] = pts[3][0] = -10
    elif k == 1: pts[1][0] = pts[2][0] = size + 10
    elif k == 2: pts[0][1] = pts[1][1] = -10
    else: pts[2][1] = pts[3][1] = size + 10
    return np.array(pts, np.int32)


def paste(img: np.ndarray, lbl: np.ndarray, bgr: np.ndarray, alpha: np.ndarray, cx: int, cy: int, label: int, allow: np.ndarray | None = None):
    h, w = alpha.shape
    x0, y0 = cx - w // 2, cy - h // 2
    X0, Y0, X1, Y1 = max(0, x0), max(0, y0), min(img.shape[1], x0 + w), min(img.shape[0], y0 + h)
    if X1 <= X0 or Y1 <= Y0:
        return
    a = alpha[Y0 - y0:Y1 - y0, X0 - x0:X1 - x0]
    if allow is not None:
        a = a * allow[Y0:Y1, X0:X1]
    s = bgr[Y0 - y0:Y1 - y0, X0 - x0:X1 - x0].astype(np.float32)
    roi = img[Y0:Y1, X0:X1]
    roi[:] = roi * (1 - a[..., None]) + s * a[..., None]
    if label >= 0:
        lbl[Y0:Y1, X0:X1][a > 0.5] = label


def transform_sprite(bgr, alpha, d: int, rng: random.Random):
    k = d / max(alpha.shape)
    inter = cv2.INTER_AREA if k < 1 else cv2.INTER_LINEAR
    bgr = cv2.resize(bgr, None, fx=k, fy=k, interpolation=inter)
    alpha = cv2.resize(alpha, (bgr.shape[1], bgr.shape[0]), interpolation=inter)
    h, w = alpha.shape
    side = int(np.ceil(np.hypot(h, w))) + 2
    M = cv2.getRotationMatrix2D((w / 2, h / 2), rng.uniform(0, 360), 1.0)
    M[0, 2] += (side - w) / 2
    M[1, 2] += (side - h) / 2
    bgr = cv2.warpAffine(bgr, M, (side, side), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    alpha = cv2.warpAffine(alpha, M, (side, side), flags=cv2.INTER_LINEAR, borderValue=0)
    if rng.random() < 0.5:
        bgr, alpha = bgr[:, ::-1], alpha[:, ::-1]
    return np.ascontiguousarray(bgr), np.ascontiguousarray(alpha)


def add_mold(img, lbl, rng: random.Random, rs: np.random.RandomState, n_spots: int) -> int:
    size = img.shape[0]
    berry = np.argwhere((lbl == GOOD) | (lbl == UNRIPE) | (lbl == DAMAGED))
    made = 0
    for _ in range(n_spots):
        if not len(berry):
            break
        cy, cx = berry[rs.randint(len(berry))]
        r = int(rng.choice([rng.uniform(5, 12), rng.uniform(8, 20), rng.uniform(14, 30)]))
        s = 2 * r + 9
        yy, xx = np.mgrid[0:s, 0:s].astype(np.float32)
        dist = np.hypot(xx - s / 2, yy - s / 2) / r
        field = smooth_noise(s, s, max(1.5, r / 3.5), rs) * 0.7 + 0.3 - dist ** 2 * 0.75
        a = np.clip((field - 0.12) * rng.uniform(3, 7), 0, 1)
        a = cv2.GaussianBlur(a, (0, 0), rng.uniform(0.7, 2.2)) * rng.uniform(0.6, 1.0)
        g = rng.uniform(150, 245)
        col = np.array([g + rng.uniform(-8, 10), g + rng.uniform(-4, 8), g + rng.uniform(-10, 6)], np.float32)
        tex = (cv2.GaussianBlur(rs.rand(s, s).astype(np.float32), (0, 0), 0.7) - 0.5) * rng.uniform(40, 110)
        spot = np.clip(col[None, None, :] + tex[..., None], 0, 255)
        before = int((lbl == MOLD).sum())
        x0, y0 = cx - s // 2, cy - s // 2
        X0, Y0, X1, Y1 = max(0, x0), max(0, y0), min(size, x0 + s), min(size, y0 + s)
        if X1 <= X0 or Y1 <= Y0:
            continue
        aa = a[Y0 - y0:Y1 - y0, X0 - x0:X1 - x0]
        roi = img[Y0:Y1, X0:X1]
        roi[:] = roi * (1 - aa[..., None]) + spot[Y0 - y0:Y1 - y0, X0 - x0:X1 - x0] * aa[..., None]
        lbl[Y0:Y1, X0:X1][aa > 0.4] = MOLD
        made += int((lbl == MOLD).sum()) > before
    return made


def add_glare(img, lbl, rng: random.Random, rs: np.random.RandomState):
    """Бліки: дрібні яскраві цятки з різким краєм на ягодах. Розмітку не змінюють."""
    berry = np.argwhere((lbl == GOOD) | (lbl == UNRIPE))
    if not len(berry):
        return
    for _ in range(rng.choice([0, 0, rng.randint(0, 80), rng.randint(0, 250)])):
        cy, cx = berry[rs.randint(len(berry))]
        v = rng.uniform(150, 255)
        if rng.random() < 0.8:
            img[cy, cx] = img[cy, cx] * 0.3 + v * 0.7             # цятка в один піксель
        else:
            cv2.circle(img, (int(cx), int(cy)), 1, (v, v, v), -1, lineType=cv2.LINE_AA)
    for _ in range(rng.choice([0, 0, 0, rng.randint(1, 5)])):                # більші відблиски (мокра ягода)
        cy, cx = berry[rs.randint(len(berry))]
        cv2.ellipse(img, (int(cx), int(cy)), (rng.randint(3, 7), rng.randint(2, 4)), rng.uniform(0, 180), 0, 360, (250, 250, 250), -1, lineType=cv2.LINE_AA)


def add_debris(img, lbl, rng: random.Random, rs: np.random.RandomState, n: int, inside: np.ndarray):
    size = img.shape[0]
    pts = np.argwhere(inside > 0)
    for _ in range(n):
        if not len(pts):
            return
        cy, cx = (int(v) for v in pts[rs.randint(len(pts))])
        col = rng.choice([(40, 90, 130), (60, 120, 160), (50, 110, 70), (40, 140, 110), (90, 150, 190), (30, 70, 100)])
        col = tuple(float(np.clip(c + rng.randint(-20, 20), 0, 255)) for c in col)
        layer = np.zeros((size, size), np.uint8)
        kind = rng.choice(["stem", "leaf", "leaf", "calyx"])
        ang = rng.uniform(0, np.pi * 2)
        if kind == "stem":
            L = rng.randint(14, 60)
            p = np.array([[cx, cy]], np.float32)
            for _ in range(3):
                ang += rng.uniform(-0.5, 0.5)
                p = np.vstack([p, p[-1] + [np.cos(ang) * L / 3, np.sin(ang) * L / 3]])
            cv2.polylines(layer, [p.astype(np.int32)], False, 255, rng.randint(1, 3), lineType=cv2.LINE_AA)
        elif kind == "leaf":
            cv2.ellipse(layer, (cx, cy), (rng.randint(8, 28), rng.randint(4, 12)), np.degrees(ang), 0, 360, 255, -1, lineType=cv2.LINE_AA)
        else:
            for k in range(5):
                a2 = ang + k * 2 * np.pi / 5
                tip = (int(cx + np.cos(a2) * rng.randint(8, 16)), int(cy + np.sin(a2) * rng.randint(8, 16)))
                side = (int(cx + np.cos(a2 + 0.5) * 4), int(cy + np.sin(a2 + 0.5) * 4))
                cv2.fillConvexPoly(layer, np.array([(cx, cy), side, tip], np.int32), 255, lineType=cv2.LINE_AA)
        a = (layer.astype(np.float32) / 255)[..., None]
        tex = 0.8 + 0.4 * smooth_noise(size, size, 2.5, rs)[..., None]
        img[:] = img * (1 - a) + np.array(col, np.float32) * tex * a
        lbl[layer > 127] = DEBRIS


def add_white_things(img, lbl, rng: random.Random, n: int) -> np.ndarray:
    """Папірці, етикетки, шматки пластику: гладкі, з різким краєм. Клас — фон. Повертає їхню маску."""
    size = img.shape[0]
    mask = np.zeros((size, size), np.uint8)
    for _ in range(n):
        cx, cy = rng.randint(0, size), rng.randint(0, size)
        w, h = rng.randint(14, 110), rng.randint(10, 80)
        box = cv2.boxPoints(((cx, cy), (w, h), rng.uniform(0, 180))).astype(np.int32)
        v = rng.randint(205, 255)
        col = (float(v + rng.randint(-6, 0)), float(v + rng.randint(-4, 0)), float(v + rng.randint(-8, 0)))
        cv2.fillConvexPoly(img, box, col, lineType=cv2.LINE_AA)
        cv2.fillConvexPoly(mask, box, 255)
    lbl[mask > 0] = BACKGROUND
    return mask


def finish(img: np.ndarray, rng: random.Random, rs: np.random.RandomState) -> np.ndarray:
    size = img.shape[0]
    ang = rng.uniform(0, 2 * np.pi)
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32) / size - 0.5
    img = img * (1 + (xx * np.cos(ang) + yy * np.sin(ang)) * rng.uniform(0, 0.5))[..., None]
    img = img * np.array([rng.uniform(0.9, 1.1), 1.0, rng.uniform(0.9, 1.1)], np.float32) * rng.uniform(0.8, 1.2)
    img = 255 * np.power(np.clip(img, 0, 255) / 255, rng.uniform(0.8, 1.25))
    if rng.random() < 0.7:
        img = cv2.GaussianBlur(img, (0, 0), rng.uniform(0.3, 1.2))
    img = img + rs.randn(size, size, 3).astype(np.float32) * rng.uniform(0, 6)
    img = np.clip(img, 0, 255).astype(np.uint8)
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, rng.randint(55, 95)])
    return cv2.imdecode(buf, cv2.IMREAD_COLOR)


def make_tray(bank: SpriteBank, seed: int, size: int = 512, species: str | None = None) -> tuple[np.ndarray, np.ndarray, dict]:
    """Одна сцена. Повертає (BGR-зображення, карта класів, опис)."""
    rng = random.Random(seed)
    rs = np.random.RandomState(seed % (2 ** 31))
    species = species or rng.choice([s for s in SPECIES if (s, GOOD) in bank.items] * 1 + (["blackberry"] * 3 if ("blackberry", GOOD) in bank.items else []))
    img = background(size, rng, rs)
    lbl = np.zeros((size, size), np.uint8)
    info = {"species": species, "mold_spots": 0, "white_px": 0, "empty": False}

    if rng.random() < 0.06:                           # сцена зовсім без ягід: стіна, папір, порожній лоток
        white = add_white_things(img, lbl, rng, rng.randint(1, 5))
        info.update(empty=True, white_px=int((white > 0).sum()))
        return finish(img, rng, rs), lbl, info

    tray = np.zeros((size, size), np.uint8)
    cv2.fillConvexPoly(tray, tray_polygon(size, rng), 255)
    allow = cv2.GaussianBlur(tray.astype(np.float32) / 255, (0, 0), 1.0)
    sparse = rng.random() < 0.25
    if sparse:                                         # дно лотка видно між ягодами
        v = rng.choice([(240, 240, 240), (225, 225, 228), rng.choice(PLASTIC)])
        img[tray > 0] = img[tray > 0] * 0.15 + np.array(v, np.float32) * 0.85
    else:                                              # щільна маса: між ягодами темно
        img[tray > 0] = np.array(DARK_BASE[species], np.float32) * rng.uniform(0.6, 1.4) + rs.randn(int((tray > 0).sum()), 3) * 4

    d_mean = rng.uniform(30, 68)
    p_unripe = rng.choice([0.0, rng.uniform(0, 0.08), rng.uniform(0.05, 0.25)])
    p_damaged = rng.choice([0.0, rng.uniform(0, 0.12)]) if (species, DAMAGED) in bank.items else 0.0
    lo, hi = BRIGHT[species]
    step = d_mean * (0.95 if sparse else 0.62)
    cells = [(x, y) for y in np.arange(-step, size + step, step) for x in np.arange(-step, size + step, step)]
    rng.shuffle(cells)
    for x, y in cells:
        if sparse and rng.random() < 0.35:
            continue
        cx, cy = int(x + rng.uniform(-step, step) * 0.45), int(y + rng.uniform(-step, step) * 0.45)
        if not (0 <= cx < size and 0 <= cy < size) or tray[cy, cx] == 0:
            continue
        u = rng.random()
        label = UNRIPE if u < p_unripe else DAMAGED if u < p_unripe + p_damaged else GOOD
        bgr, alpha = bank.get(rng, species, label)
        bgr, alpha = transform_sprite(bgr, alpha, max(16, int(d_mean * rng.uniform(0.75, 1.3))), rng)
        bgr = np.clip(bgr.astype(np.float32) * rng.uniform(lo, hi), 0, 255)
        shadow = cv2.GaussianBlur(alpha, (0, 0), 3) * 0.55          # тінь під ягодою
        paste(img, lbl, np.zeros_like(bgr), shadow, cx + 2, cy + 3, -1, allow)
        paste(img, lbl, bgr, alpha, cx, cy, label, allow)

    berry_mask = ((lbl > 0) & (lbl != DEBRIS)).astype(np.uint8)
    add_debris(img, lbl, rng, rs, rng.choice([0, 0, 1, 2, 4, 8]), berry_mask)
    add_glare(img, lbl, rng, rs)
    if rng.random() < 0.45:
        info["mold_spots"] = add_mold(img, lbl, rng, rs, rng.choice([1, 2, 3, 5, 8, 14]))
    if rng.random() < 0.35:
        info["white_px"] = int((add_white_things(img, lbl, rng, rng.randint(1, 3)) > 0).sum())
    return finish(img, rng, rs), lbl, info
