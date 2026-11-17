"""Навчання сегментаційної моделі на datasets/prepared. Результат — runs/<назва>/best.pt (поза git).

    .venv\\Scripts\\python.exe training\\train.py --name v1 --minutes 60

Розраховано на GTX 1650 (4 ГБ): мала мережа, batch 16, кроп 320, змішана точність (AMP).
Без CUDA автоматично працює на CPU (повільно: зменште --minutes і --crop).

Втрати:
  dense — крос-ентропія з вагами класів (пліснява важить найбільше: пропуск плісняви — найгірша помилка);
  weak  — для фото з міткою на все зображення (SmartBerry): клас «є» — хоч десь висока ймовірність,
          клас «немає» — ніде немає високої ймовірності (середнє top-k пікселів);
  species — вид ягоди (допоміжна, мала вага).
"""
from __future__ import annotations

import argparse
import json
import math
import os
import random
import sys
import time
from pathlib import Path

import cv2
import numpy as np
import torch
import torch.nn.functional as F
from torch.utils.data import DataLoader, Dataset

sys.path.insert(0, str(Path(__file__).parent))
from model import MULTIPLE, build_model  # noqa: E402
from taxonomy import CLASSES, IGNORE, MOLD, NUM_CLASSES, SPECIES  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "datasets" / "prepared"
RUNS = ROOT / "runs"
os.environ.setdefault("TORCH_HOME", str(ROOT / ".cache" / "torch"))

CLASS_WEIGHTS = [1.0, 1.0, 2.0, 2.0, 5.0, 2.0]       # фон, якісна, недостигла, пошкоджена, пліснява, домішки


def read_meta(split: str) -> list[dict]:
    with open(DATA / split / "meta.jsonl", encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def load_pair(split: str, m: dict) -> tuple[np.ndarray, np.ndarray]:
    img = cv2.imread(str(DATA / split / f"{m['file']}.jpg"), cv2.IMREAD_COLOR)
    lbl = cv2.imread(str(DATA / split / f"{m['file']}.png"), cv2.IMREAD_GRAYSCALE)
    return cv2.cvtColor(img, cv2.COLOR_BGR2RGB), lbl


def color_jitter(img: np.ndarray, rng: random.Random) -> np.ndarray:
    """Лише помірні зміни кольору: відтінок несе клас (червоне = недостигле для ожини), тому зсув відтінку малий."""
    x = img.astype(np.float32)
    x = x * rng.uniform(0.7, 1.3) + rng.uniform(-18, 18)                 # яскравість
    mean = x.mean()
    x = (x - mean) * rng.uniform(0.8, 1.2) + mean                         # контраст
    x = x * np.array([rng.uniform(0.92, 1.08), 1.0, rng.uniform(0.92, 1.08)], np.float32)   # відтінок лампи
    x = np.clip(x, 0, 255).astype(np.uint8)
    hsv = cv2.cvtColor(x, cv2.COLOR_RGB2HSV).astype(np.int16)
    hsv[..., 0] = (hsv[..., 0] + rng.randint(-3, 3)) % 180
    hsv[..., 1] = np.clip(hsv[..., 1] * rng.uniform(0.85, 1.15), 0, 255)
    x = cv2.cvtColor(hsv.astype(np.uint8), cv2.COLOR_HSV2RGB)
    if rng.random() < 0.3:
        x = cv2.GaussianBlur(x, (0, 0), rng.uniform(0.3, 1.0))
    return x


class SegData(Dataset):
    def __init__(self, split: str, crop: int, train: bool):
        self.split, self.crop, self.train = split, crop, train
        self.meta = read_meta(split)
        if not train:
            self.meta = [m for m in self.meta if m["kind"] == "dense"]

    def __len__(self) -> int:
        return len(self.meta)

    def __getitem__(self, i: int):
        cv2.setNumThreads(0)
        m = self.meta[i]
        rng = random.Random((i * 7919 + int(time.time() * 1000)) if self.train else i)
        img, lbl = load_pair(self.split, m)
        c = self.crop
        weak = m["kind"] == "weak"
        valid = np.ones(lbl.shape, np.uint8)
        if weak or not self.train:
            # усе фото, вписане в квадрат c×c (для слабкої мітки обрізати не можна: об'єкт може випасти)
            k = c / max(img.shape[:2])
            img = cv2.resize(img, None, fx=k, fy=k, interpolation=cv2.INTER_AREA)
            lbl = cv2.resize(lbl, (img.shape[1], img.shape[0]), interpolation=cv2.INTER_NEAREST)
            valid = np.ones(lbl.shape, np.uint8)
        else:
            k = rng.uniform(0.7, 1.35)
            img = cv2.resize(img, None, fx=k, fy=k, interpolation=cv2.INTER_AREA if k < 1 else cv2.INTER_LINEAR)
            lbl = cv2.resize(lbl, (img.shape[1], img.shape[0]), interpolation=cv2.INTER_NEAREST)
            valid = np.ones(lbl.shape, np.uint8)
            h, w = lbl.shape
            if h > c or w > c:
                y0, x0 = rng.randint(0, max(0, h - c)), rng.randint(0, max(0, w - c))
                img, lbl, valid = img[y0:y0 + c, x0:x0 + c], lbl[y0:y0 + c, x0:x0 + c], valid[y0:y0 + c, x0:x0 + c]
        # доповнити до c×c
        h, w = lbl.shape
        if h < c or w < c:
            pi = np.zeros((c, c, 3), np.uint8); pl = np.full((c, c), IGNORE, np.uint8); pv = np.zeros((c, c), np.uint8)
            pi[:h, :w], pl[:h, :w], pv[:h, :w] = img, lbl, valid
            img, lbl, valid = pi, pl, pv
        if self.train:
            if rng.random() < 0.5:
                img, lbl, valid = img[:, ::-1], lbl[:, ::-1], valid[:, ::-1]
            if rng.random() < 0.5:
                img, lbl, valid = img[::-1], lbl[::-1], valid[::-1]
            r = rng.randint(0, 3)
            img, lbl, valid = np.rot90(img, r), np.rot90(lbl, r), np.rot90(valid, r)
            img = color_jitter(np.ascontiguousarray(img), rng)
        present = np.zeros(NUM_CLASSES, np.float32); absent = np.zeros(NUM_CLASSES, np.float32)
        if weak:
            present[m["present"]] = 1; absent[m["absent"]] = 1
        sp = SPECIES.index(m["species"]) if m.get("species") in SPECIES else -1
        x = torch.from_numpy(np.ascontiguousarray(img)).permute(2, 0, 1).float() / 255
        return (x, torch.from_numpy(np.ascontiguousarray(lbl)).long(), torch.from_numpy(np.ascontiguousarray(valid)).float(),
                torch.tensor(weak), torch.from_numpy(present), torch.from_numpy(absent), torch.tensor(sp))


def weak_loss(logits: torch.Tensor, valid: torch.Tensor, present: torch.Tensor, absent: torch.Tensor) -> torch.Tensor:
    prob = logits.float().softmax(1)                                     # N×C×h×w (крок 4)
    v = F.interpolate(valid[:, None], size=prob.shape[-2:], mode="nearest")[:, 0]
    n, c = prob.shape[:2]
    flat = (prob * v[:, None]).flatten(2)                                # недійсні пікселі = 0
    k = max(4, int(0.01 * flat.shape[-1]))
    top = flat.topk(k, dim=-1).values.mean(-1)                           # N×C
    eps = 1e-4
    lp = -(torch.log(top + eps) * present).sum() / present.sum().clamp(min=1)
    la = -(torch.log(1 - top + eps) * absent).sum() / absent.sum().clamp(min=1)
    return lp + la


@torch.no_grad()
def evaluate(model, loader, device) -> dict:
    model.eval()
    conf = torch.zeros(NUM_CLASSES, NUM_CLASSES, dtype=torch.long, device=device)
    for x, lbl, *_ in loader:
        x, lbl = x.to(device), lbl.to(device)
        with torch.autocast(device.type, enabled=device.type == "cuda"):
            logits, _ = model(x)
        pred = F.interpolate(logits.float(), size=lbl.shape[-2:], mode="bilinear", align_corners=False).argmax(1)
        ok = lbl != IGNORE
        conf += torch.bincount(lbl[ok] * NUM_CLASSES + pred[ok], minlength=NUM_CLASSES ** 2).view(NUM_CLASSES, NUM_CLASSES)
    conf = conf.double()
    tp = conf.diag()
    iou = tp / (conf.sum(0) + conf.sum(1) - tp).clamp(min=1)
    recall = tp / conf.sum(1).clamp(min=1)
    precision = tp / conf.sum(0).clamp(min=1)
    model.train()
    return {"iou": iou.tolist(), "recall": recall.tolist(), "precision": precision.tolist(),
            "miou": float(iou[1:].mean()), "mold_recall": float(recall[MOLD]), "mold_precision": float(precision[MOLD])}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--name", default="v1")
    ap.add_argument("--minutes", type=float, default=60, help="обмеження часу навчання")
    ap.add_argument("--epochs", type=int, default=40)
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--crop", type=int, default=320)
    ap.add_argument("--lr", type=float, default=2e-3)
    ap.add_argument("--workers", type=int, default=6)
    a = ap.parse_args()
    assert a.crop % MULTIPLE == 0

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print("Пристрій:", torch.cuda.get_device_name(0) if device.type == "cuda" else "CPU (CUDA недоступна — навчання буде повільним)")
    torch.backends.cudnn.benchmark = True
    out = RUNS / a.name
    out.mkdir(parents=True, exist_ok=True)

    train_ds, val_ds = SegData("train", a.crop, True), SegData("val", 384, False)
    tl = DataLoader(train_ds, a.batch, shuffle=True, num_workers=a.workers, drop_last=True, persistent_workers=True, pin_memory=True)
    vl = DataLoader(val_ds, 8, shuffle=False, num_workers=2, persistent_workers=True)
    print(f"навчальних: {len(train_ds)}, перевірочних (піксельна розмітка): {len(val_ds)}")

    model = build_model(pretrained=True).to(device)
    opt = torch.optim.AdamW(model.parameters(), lr=a.lr, weight_decay=1e-4)
    total = a.epochs * len(tl)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=a.lr, total_steps=total, pct_start=0.1)
    scaler = torch.amp.GradScaler(enabled=device.type == "cuda")
    cw = torch.tensor(CLASS_WEIGHTS, device=device)

    t0, best, history, step = time.time(), -1.0, [], 0
    for epoch in range(a.epochs):
        sums = {"dense": 0.0, "weak": 0.0, "species": 0.0}
        for x, lbl, valid, weak, present, absent, sp in tl:
            x, lbl, valid = x.to(device, non_blocking=True), lbl.to(device, non_blocking=True), valid.to(device)
            weak, present, absent, sp = weak.to(device), present.to(device), absent.to(device), sp.to(device)
            with torch.autocast(device.type, enabled=device.type == "cuda"):
                logits, sp_logits = model(x)
            up = F.interpolate(logits.float(), size=lbl.shape[-2:], mode="bilinear", align_corners=False)
            l_dense = F.cross_entropy(up, lbl, weight=cw, ignore_index=IGNORE) if (lbl != IGNORE).any() else up.sum() * 0
            l_weak = weak_loss(logits[weak], valid[weak], present[weak], absent[weak]) if weak.any() else up.sum() * 0
            l_sp = F.cross_entropy(sp_logits.float()[sp >= 0], sp[sp >= 0]) if (sp >= 0).any() else up.sum() * 0
            loss = l_dense + 0.3 * l_weak + 0.2 * l_sp
            opt.zero_grad(set_to_none=True)
            scaler.scale(loss).backward()
            scaler.step(opt)
            scaler.update()
            if step < total - 1:
                sched.step()
            step += 1
            sums["dense"] += float(l_dense); sums["weak"] += float(l_weak); sums["species"] += float(l_sp)
        ev = evaluate(model, vl, device)
        score = ev["miou"] + 0.5 * ev["mold_recall"]
        mins = (time.time() - t0) / 60
        rec = {"epoch": epoch + 1, "minutes": round(mins, 1), **{k: round(v / len(tl), 4) for k, v in sums.items()}, **ev, "score": score}
        history.append(rec)
        print(f"епоха {epoch + 1:2d} · {mins:5.1f} хв · втрата {rec['dense']:.3f}/{rec['weak']:.3f}/{rec['species']:.3f} · "
              f"mIoU {ev['miou']:.3f} · IoU " + " ".join(f"{CLASSES[i][:4]} {v:.2f}" for i, v in enumerate(ev["iou"])) +
              f" · пліснява recall {ev['mold_recall']:.3f} precision {ev['mold_precision']:.3f}", flush=True)
        if score > best:
            best = score
            torch.save({"model": model.state_dict(), "epoch": epoch + 1, "val": ev, "args": vars(a)}, out / "best.pt")
        (out / "history.json").write_text(json.dumps(history, indent=1), encoding="utf-8")
        # чи встигнемо ще одну епоху в межах часу
        if mins + mins / (epoch + 1) > a.minutes:
            print(f"Зупинка за часом ({a.minutes} хв) після епохи {epoch + 1}")
            break
    torch.save({"model": model.state_dict(), "epoch": epoch + 1, "args": vars(a)}, out / "last.pt")
    print(f"Найкраща модель: {out / 'best.pt'} (оцінка {best:.3f})")


if __name__ == "__main__":
    main()
