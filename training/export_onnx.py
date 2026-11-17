"""Експорт навченої моделі в ONNX для браузера + квантизація до int8.

    .venv\\Scripts\\python.exe training\\export_onnx.py --run v1

Результат (єдине, що йде в деплой):
  models/berry-seg.onnx       — модель (int8, якщо квантизація не зіпсувала результат; інакше float32);
  models/berry-seg.json       — опис: версія, класи, вид ягоди, розмір входу, перевірка точності квантизації.
Проміжні файли (float32, калібрування) — у runs/<назва>/ (поза git).
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import cv2
import numpy as np
import onnx
import onnxruntime as ort
import torch
from onnxruntime.quantization import CalibrationDataReader, QuantFormat, QuantType, quantize_static
from onnxruntime.quantization.shape_inference import quant_pre_process

sys.path.insert(0, str(Path(__file__).parent))
from model import MULTIPLE, STRIDE, build_model  # noqa: E402
from taxonomy import CLASSES, LABELS_UK, SPECIES  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "datasets" / "prepared"
MODELS = ROOT / "models"
CF_LIMIT = 25 * 1024 * 1024          # ліміт Cloudflare на один файл


def calib_images(n: int = 64, side: int = 512) -> list[np.ndarray]:
    meta = [json.loads(s) for s in open(DATA / "val" / "meta.jsonl", encoding="utf-8") if s.strip()]
    rng = np.random.RandomState(0)
    rng.shuffle(meta)
    out = []
    for m in meta[:n]:
        img = cv2.cvtColor(cv2.imread(str(DATA / "val" / f"{m['file']}.jpg")), cv2.COLOR_BGR2RGB)
        img = cv2.resize(img, (side, side), interpolation=cv2.INTER_AREA)
        out.append(img.astype(np.float32).transpose(2, 0, 1)[None] / 255)
    return out


class Reader(CalibrationDataReader):
    def __init__(self, imgs):
        self.it = iter(imgs)

    def get_next(self):
        x = next(self.it, None)
        return None if x is None else {"image": x}


def run(sess: ort.InferenceSession, x: np.ndarray):
    return sess.run(None, {"image": x})


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", default="v1")
    ap.add_argument("--version", default=None, help="рядок версії моделі для звіту (типово model-<run>)")
    a = ap.parse_args()
    run_dir = ROOT / "runs" / a.run
    ck = torch.load(run_dir / "best.pt", map_location="cpu", weights_only=False)
    model = build_model(pretrained=False).eval()
    model.load_state_dict(ck["model"])

    fp32 = run_dir / "berry-seg.fp32.onnx"
    dummy = torch.zeros(1, 3, 512, 512)
    torch.onnx.export(model, dummy, str(fp32), input_names=["image"], output_names=["logits", "species"], opset_version=17,
                      dynamic_axes={"image": {2: "h", 3: "w"}, "logits": {2: "gh", 3: "gw"}}, dynamo=False)
    onnx.checker.check_model(onnx.load(str(fp32)))
    print(f"float32: {fp32.stat().st_size / 1e6:.2f} МБ")

    pre = run_dir / "berry-seg.pre.onnx"
    quant_pre_process(str(fp32), str(pre), skip_symbolic_shape=True)
    q8 = run_dir / "berry-seg.int8.onnx"
    imgs = calib_images()
    quantize_static(str(pre), str(q8), Reader(imgs), quant_format=QuantFormat.QDQ, per_channel=True,
                    activation_type=QuantType.QUInt8, weight_type=QuantType.QInt8)
    print(f"int8: {q8.stat().st_size / 1e6:.2f} МБ")

    # перевірка: наскільки квантизована модель погоджується з float32 (карта класів на перевірочних фото)
    s32 = ort.InferenceSession(str(fp32), providers=["CPUExecutionProvider"])
    s8 = ort.InferenceSession(str(q8), providers=["CPUExecutionProvider"])
    agree, mold_agree, t32, t8 = [], [], 0.0, 0.0
    for x in calib_images(40, 768)[:40]:
        t = time.time(); l32 = run(s32, x)[0]; t32 += time.time() - t
        t = time.time(); l8 = run(s8, x)[0]; t8 += time.time() - t
        p32, p8 = l32.argmax(1), l8.argmax(1)
        agree.append(float((p32 == p8).mean()))
        m = (p32 == 4) | (p8 == 4)
        if m.sum() > 10:
            mold_agree.append(float(((p32 == 4) == (p8 == 4))[m].mean()))
    ag, mag = float(np.mean(agree)), float(np.mean(mold_agree)) if mold_agree else 1.0
    print(f"збіг int8 з float32: {100 * ag:.1f} % пікселів, пліснява {100 * mag:.1f} % · CPU на 768×768: float32 {1000 * t32 / 40:.0f} мс, int8 {1000 * t8 / 40:.0f} мс")
    use_int8 = ag >= 0.97 and mag >= 0.85
    chosen = q8 if use_int8 else fp32

    MODELS.mkdir(exist_ok=True)
    dst = MODELS / "berry-seg.onnx"
    dst.write_bytes(chosen.read_bytes())
    assert dst.stat().st_size < CF_LIMIT, "модель більша за ліміт Cloudflare на файл"
    info = {
        "version": a.version or f"model-{a.run}",
        "file": dst.name, "bytes": dst.stat().st_size, "precision": "int8" if use_int8 else "float32",
        "classes": CLASSES, "labels_uk": LABELS_UK, "species": SPECIES,
        "input": {"name": "image", "layout": "NCHW", "range": "0..1 RGB", "multiple": MULTIPLE, "long_side": 1024},
        "outputs": {"logits": f"N×{len(CLASSES)}×H/{STRIDE}×W/{STRIDE}", "species": f"N×{len(SPECIES)}"},
        "stride": STRIDE, "epoch": ck.get("epoch"), "val": ck.get("val"),
        "quantization_check": {"pixel_agreement": round(ag, 4), "mold_agreement": round(mag, 4)},
        "exported_at": time.strftime("%Y-%m-%d %H:%M"),
    }
    (MODELS / "berry-seg.json").write_text(json.dumps(info, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"→ {dst} ({info['precision']}, {dst.stat().st_size / 1e6:.2f} МБ)")


if __name__ == "__main__":
    main()
