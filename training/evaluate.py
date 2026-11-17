"""Оцінка моделі й кольорового методу на відкладеній (тестовій) частині даних.

    node tools\\eval_color.js test                                   # спершу: прогнати кольоровий метод
    .venv\\Scripts\\python.exe training\\evaluate.py --run v1          # потім: оцінка й порівняння

Результат: runs/<назва>/eval.json і runs/<назва>/eval.md (таблиці для EVALUATION.md),
runs/<назва>/sample_*.jpg — якісний огляд на data/samples (лише для перегляду, не для чисел).

Групи тестових даних:
  synth        — синтетичні лотки (ягоди з реальних фото, пліснява/бліки/папір домальовані): усі класи;
  raspberryset — реальні фото малини на кущі: лише якісні/недостиглі/фон, розмітка зведена з рамок;
  white_bg     — полуниця на білому тлі (Fruits Dataset for Classification): перевірка «біле ≠ пліснява»;
  smartberry   — реальні фото полуниці в полі з міткою на все фото (є/немає плісняви, гнилі).
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import cv2
import numpy as np
import torch
import torch.nn.functional as F

sys.path.insert(0, str(Path(__file__).parent))
from model import MULTIPLE, build_model  # noqa: E402
from taxonomy import BACKGROUND, CLASSES, DAMAGED, IGNORE, LABELS_UK, MOLD, NUM_CLASSES, SPECIES  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "datasets" / "prepared"
COLOR = ROOT / "datasets" / "eval" / "color"
SAMPLE = ROOT / "data" / "samples" / "photo_2026-11-12_18-39-37.jpg"
PAL = np.array([[0, 0, 0], [52, 168, 83], [255, 225, 0], [255, 140, 0], [255, 59, 48], [186, 104, 255]], np.uint8)  # RGB, як у браузері
MIN_SPOT = 20          # пляма плісняви в розмітці, px (при масштабі фото 1024)


def load_model(run: str, device):
    ck = torch.load(ROOT / "runs" / run / "best.pt", map_location=device, weights_only=False)
    m = build_model(pretrained=False).to(device).eval()
    m.load_state_dict(ck["model"])
    return m, ck


@torch.no_grad()
def predict(model, rgb: np.ndarray, device) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """→ (карта класів розміром фото, ймовірності на сітці кроку 4, ймовірності виду)."""
    h, w = rgb.shape[:2]
    H, W = -(-h // MULTIPLE) * MULTIPLE, -(-w // MULTIPLE) * MULTIPLE
    x = np.zeros((H, W, 3), np.float32)
    x[:h, :w] = rgb.astype(np.float32) / 255
    t = torch.from_numpy(x).permute(2, 0, 1)[None].to(device)
    logits, sp = model(t)
    up = F.interpolate(logits.float(), size=(H, W), mode="bilinear", align_corners=False)[0, :, :h, :w]
    prob = logits.float().softmax(1)[0].cpu().numpy()
    return up.argmax(0).cpu().numpy().astype(np.uint8), prob, sp.float().softmax(1)[0].cpu().numpy()


class Acc:
    """Накопичує метрики для однієї групи й одного методу."""

    def __init__(self):
        self.conf = np.zeros((NUM_CLASSES, NUM_CLASSES), np.int64)
        self.comp_err = {c: [] for c in range(1, NUM_CLASSES)}
        self.spots = [0, 0]              # [знайдено, усього] плям плісняви в розмітці
        self.mold_imgs = [0, 0]          # фото з пліснявою: [виявлено, усього]
        self.clean_false = [0, 0]        # фото без плісняви: [з хибною пліснявою, усього]
        self.white_px = [0, 0]           # білі пікселі фону: [позначено пліснявою, усього]
        self.white_imgs = [0, 0]         # фото з білими поверхнями: [з хибною плямою плісняви на білому, усього]

    def add(self, gt: np.ndarray, pred: np.ndarray, rgb: np.ndarray):
        ok = gt != IGNORE
        self.conf += np.bincount(gt[ok].astype(np.int64) * NUM_CLASSES + pred[ok], minlength=NUM_CLASSES ** 2).reshape(NUM_CLASSES, NUM_CLASSES)
        # частки категорій від площі ягід — те, що бачить користувач у звіті
        g_berry = ok & (gt > 0)
        p_berry = pred > 0
        if g_berry.sum() > 0.02 * gt.size:
            for c in range(1, NUM_CLASSES):
                gp = 100 * float((gt[ok] == c).sum()) / max(1, g_berry.sum())
                pp = 100 * float((pred == c).sum()) / max(1, p_berry.sum())
                self.comp_err[c].append(abs(gp - pp))
        # пліснява: плями й фото
        gm = (gt == MOLD).astype(np.uint8)
        pm = pred == MOLD
        n, lab, st, _ = cv2.connectedComponentsWithStats(gm, 8)
        for k in range(1, n):
            if st[k, cv2.CC_STAT_AREA] >= MIN_SPOT:
                self.spots[1] += 1
                self.spots[0] += int(pm[lab == k].mean() >= 0.3)
        berry = max(1, int(g_berry.sum()))
        if gm.sum() >= max(MIN_SPOT, 0.002 * berry):
            self.mold_imgs[1] += 1
            self.mold_imgs[0] += int(pm.sum() >= 0.3 * gm.sum())
        elif gm.sum() == 0:
            self.clean_false[1] += 1
            self.clean_false[0] += int(spot_count(pm, MIN_SPOT) > 0)
        # біле тло (стіна, папір, біле дно лотка): фон у розмітці, світле й ненасичене
        hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV)
        white = (gt == BACKGROUND) & (hsv[..., 2] > 150) & (hsv[..., 1] < 50)
        if white.sum() >= 200:
            self.white_px[1] += int(white.sum())
            self.white_px[0] += int((pm & white).sum())
            self.white_imgs[1] += 1
            self.white_imgs[0] += int(spot_count(pm & white, MIN_SPOT) > 0)

    def result(self) -> dict:
        c = self.conf.astype(np.float64)
        tp = np.diag(c)
        gt_n, pr_n = c.sum(1), c.sum(0)
        iou = tp / np.maximum(1, gt_n + pr_n - tp)
        r = lambda a: round(a[0] / a[1], 3) if a[1] else None
        return {
            "pixels": {CLASSES[i]: {"n_gt": int(gt_n[i]), "recall": round(tp[i] / gt_n[i], 3) if gt_n[i] else None,
                                    "precision": round(tp[i] / pr_n[i], 3) if pr_n[i] else None,
                                    "iou": round(iou[i], 3) if gt_n[i] else None} for i in range(NUM_CLASSES)},
            "composition_mae_pp": {CLASSES[k]: round(float(np.mean(v)), 2) if v else None for k, v in self.comp_err.items()},
            "mold_spot_recall": r(self.spots), "mold_spots": self.spots[1],
            "mold_image_recall": r(self.mold_imgs), "mold_images": self.mold_imgs[1],
            "false_mold_image_rate": r(self.clean_false), "clean_images": self.clean_false[1],
            "false_mold_white_px": round(self.white_px[0] / self.white_px[1], 5) if self.white_px[1] else None,
            "false_mold_white_images": r(self.white_imgs), "white_images": self.white_imgs[1],
        }


OTHER = 6             # «фон / інше» в карті кольорового методу


def hybrid(color: np.ndarray, prob: np.ndarray, species: str | None) -> np.ndarray:
    """Те саме правило, що js/ml/model.js (режим «Гібрид»): основа — кольоровий метод, модель його перевіряє."""
    h, w = color.shape
    t = torch.from_numpy(prob)[None]
    p = F.interpolate(t, size=(-(-h // 4) * 4, -(-w // 4) * 4), mode="bilinear", align_corners=False)[0, :, :h, :w].numpy()
    out = color.copy()
    zone = color > 0
    veto = zone & (color == MOLD) & (p[0] > 0.6) & (p[MOLD] < 0.15)
    add = zone & (color != MOLD) & (color != OTHER) & (p[MOLD] > 0.6)
    out[veto] = OTHER
    out[add] = MOLD
    if species == "strawberry":                              # «пошкоджені» модель бачила лише для полуниці
        out[zone & ~add & (color == 1) & (p[DAMAGED] > 0.55)] = DAMAGED
    return out


def spot_count(mask: np.ndarray, min_area: int) -> int:
    n, _, st, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8), 8)
    return int((st[1:, cv2.CC_STAT_AREA] >= min_area).sum())


def group_of(m: dict) -> str:
    if m["source"] == "synth":
        return "synth"
    if m["source"] == "fruitscls":
        return "white_bg"
    return m["source"]


def overlay(rgb: np.ndarray, lab: np.ndarray) -> np.ndarray:
    a = np.where(lab[..., None] == 1, 0.18, np.where(lab[..., None] == 0, 0.0, 0.75))
    out = rgb * (1 - a) + PAL[lab] * a
    out[lab == 0] = out[lab == 0] * 0.55
    return out.astype(np.uint8)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", default="v1")
    ap.add_argument("--split", default="test")
    a = ap.parse_args()
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model, ck = load_model(a.run, device)
    out = ROOT / "runs" / a.run
    meta = [json.loads(s) for s in open(DATA / a.split / "meta.jsonl", encoding="utf-8") if s.strip()]
    color_ok = (COLOR / a.split / "summary.json").exists()
    color_sum = json.loads((COLOR / a.split / "summary.json").read_text()) if color_ok else {}

    accs: dict[tuple[str, str], Acc] = {}
    weak: dict[str, dict[str, list]] = {}
    species_hits: dict[str, list[int]] = {}
    for m in meta:
        rgb = cv2.cvtColor(cv2.imread(str(DATA / a.split / f"{m['file']}.jpg")), cv2.COLOR_BGR2RGB)
        pred, prob, sp = predict(model, rgb, device)
        g = group_of(m)
        if m.get("species") in SPECIES:
            species_hits.setdefault(g, []).append(int(SPECIES[int(sp.argmax())] == m["species"]))
        cpath = COLOR / a.split / f"{m['file']}.png"
        craw = cv2.imread(str(cpath), cv2.IMREAD_GRAYSCALE) if color_ok and cpath.exists() else None
        cpred = np.where(craw == OTHER, 0, craw).astype(np.uint8) if craw is not None else None
        hpred = None
        if craw is not None:
            hp = hybrid(craw, prob, m.get("species"))
            hpred = np.where(hp == OTHER, 0, hp).astype(np.uint8)
        if m["kind"] == "dense":
            gt = cv2.imread(str(DATA / a.split / f"{m['file']}.png"), cv2.IMREAD_GRAYSCALE)
            accs.setdefault((g, "model"), Acc()).add(gt, pred, rgb)
            if cpred is not None:
                accs.setdefault((g, "color"), Acc()).add(gt, cpred, rgb)
                accs.setdefault((g, "hybrid"), Acc()).add(gt, hpred, rgb)
        else:
            # мітка на все фото: частка плісняви / пошкоджених серед ягід
            for name, lab in (("model", pred), ("color", cpred), ("hybrid", hpred)):
                if lab is None:
                    continue
                berry = max(1, int((lab > 0).sum()))
                weak.setdefault(name, {}).setdefault(m["image_class"], []).append(
                    {"mold": 100 * float((lab == MOLD).sum()) / berry, "damaged": 100 * float((lab == DAMAGED).sum()) / berry})

    res = {"run": a.run, "epoch": ck.get("epoch"), "split": a.split, "groups": {}, "weak": {}, "species_accuracy": {}}
    for (g, method), acc in sorted(accs.items()):
        res["groups"].setdefault(g, {})[method] = acc.result()
    for method, by in weak.items():
        res["weak"][method] = {cls: {"n": len(v), "with_mold_over_1pct": round(float(np.mean([x["mold"] > 1 for x in v])), 3),
                                     "mean_mold_pct": round(float(np.mean([x["mold"] for x in v])), 2),
                                     "with_damaged_over_5pct": round(float(np.mean([x["damaged"] > 5 for x in v])), 3)} for cls, v in by.items()}
    res["species_accuracy"] = {g: {"n": len(v), "accuracy": round(float(np.mean(v)), 3)} for g, v in species_hits.items()}

    # якісний огляд на реальному фото (не для чисел)
    if SAMPLE.exists():
        bgr = cv2.imread(str(SAMPLE))
        k = 1024 / max(bgr.shape[:2])
        rgb = cv2.cvtColor(cv2.resize(bgr, None, fx=k, fy=k, interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2RGB)
        pred, prob, sp = predict(model, rgb, device)
        berry = max(1, int((pred > 0).sum()))
        res["sample"] = {"percents": {CLASSES[c]: round(100 * float((pred == c).sum()) / berry, 2) for c in range(1, NUM_CLASSES)},
                         "berry_fraction": round(berry / pred.size, 3),
                         "species": {SPECIES[i]: round(float(p), 3) for i, p in enumerate(sp)}}
        side = np.hstack([rgb, overlay(rgb, pred)])
        cv2.imwrite(str(out / "sample_model.jpg"), cv2.cvtColor(cv2.resize(side, None, fx=0.6, fy=0.6, interpolation=cv2.INTER_AREA), cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 82])

    (out / "eval.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    (out / "eval.md").write_text(to_markdown(res), encoding="utf-8")
    print(to_markdown(res))


MNAME = {"color": "кольоровий", "hybrid": "гібрид", "model": "модель"}


def fmt(v, pct=True) -> str:
    if v is None:
        return "—"
    return f"{100 * v:.1f} %".replace(".", ",") if pct else f"{v:.2f}".replace(".", ",")


def to_markdown(res: dict) -> str:
    L = []
    names = {"synth": "Синтетичні лотки", "raspberryset": "RaspberrySet (реальні фото малини)", "white_bg": "Полуниця на білому тлі"}
    for g, by in res["groups"].items():
        L.append(f"### {names.get(g, g)}\n")
        L.append("| Клас | Метод | Recall | Precision | IoU | Похибка частки, п.п. |")
        L.append("|---|---|---|---|---|---|")
        for c in range(1, NUM_CLASSES):
            for method in ("color", "hybrid", "model"):
                if method not in by:
                    continue
                r = by[method]
                p = r["pixels"][CLASSES[c]]
                if not p["n_gt"] and not p["precision"]:
                    continue
                L.append(f"| {LABELS_UK[c]} | {MNAME[method]} | {fmt(p['recall'])} | {fmt(p['precision'])} | "
                         f"{fmt(p['iou'])} | {fmt(r['composition_mae_pp'][CLASSES[c]], False)} |")
        L.append("")
        order = [m for m in ("color", "hybrid", "model") if m in by]
        L.append("| Пліснява | " + " | ".join(MNAME[m] for m in order) + " |")
        L.append("|---|" + "---|" * len(order))
        rows = [("Плям плісняви знайдено (recall плям)", "mold_spot_recall", "mold_spots"),
                ("Фото з пліснявою виявлено (recall фото)", "mold_image_recall", "mold_images"),
                ("Фото без плісняви з хибною плямою", "false_mold_image_rate", "clean_images"),
                ("Хибна пліснява: частка білих пікселів фону", "false_mold_white_px", None),
                ("Фото з білими поверхнями, де є хибна пляма на білому", "false_mold_white_images", "white_images")]
        for title, key, nkey in rows:
            vals = []
            for m in order:
                v = by[m][key]
                vals.append((f"{100 * v:.2f} %".replace(".", ",") if key == "false_mold_white_px" and v is not None else fmt(v)) +
                            (f" (n={by[m][nkey]})" if nkey else ""))
            L.append(f"| {title} | " + " | ".join(vals) + " |")
        L.append("")
    if res.get("weak"):
        L.append("### SmartBerry (реальні фото полуниці, мітка на все фото)\n")
        L.append("| Клас фото | Метод | Фото | Частка фото з пліснявою > 1 % | Середня пліснява, % | Частка фото з пошкодженими > 5 % |")
        L.append("|---|---|---|---|---|---|")
        for cls in sorted(next(iter(res["weak"].values()))):
            for m in ("color", "hybrid", "model"):
                if m not in res["weak"] or cls not in res["weak"][m]:
                    continue
                v = res["weak"][m][cls]
                L.append(f"| {cls} | {MNAME[m]} | {v['n']} | {fmt(v['with_mold_over_1pct'])} | "
                         f"{fmt(v['mean_mold_pct'] / 100)} | {fmt(v['with_damaged_over_5pct'])} |")
        L.append("")
    if res.get("species_accuracy"):
        L.append("### Вид ягоди (допоміжний вихід моделі)\n")
        L.append("| Група | Фото | Точність |\n|---|---|---|")
        for g, v in res["species_accuracy"].items():
            L.append(f"| {names.get(g, g)} | {v['n']} | {fmt(v['accuracy'])} |")
        L.append("")
    if res.get("sample"):
        s = res["sample"]
        L.append("### Зразок data/samples (лише якісний огляд)\n")
        L.append("Модель: " + ", ".join(f"{LABELS_UK[CLASSES.index(k)]} {v:.1f} %" for k, v in s["percents"].items()) +
                 f"; ягоди {100 * s['berry_fraction']:.0f} % кадру; вид: " + ", ".join(f"{k} {v:.2f}" for k, v in s["species"].items()))
    return "\n".join(L)


if __name__ == "__main__":
    main()
