"""Порівняння варіантів квантизації моделі до int8 з float32 (збіг карти класів і плісняви, розмір, швидкість на CPU).

    .venv\\Scripts\\python.exe training\\quant_check.py --run v2

Потрібен runs/<назва>/berry-seg.fp32.onnx (робить export_onnx.py). Результат — таблиця в консолі й runs/<назва>/quant.json.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort
from onnxruntime.quantization import CalibrationDataReader, CalibrationMethod, QuantFormat, QuantType, quantize_dynamic, quantize_static
from onnxruntime.quantization.shape_inference import quant_pre_process

sys.path.insert(0, str(Path(__file__).parent))
from export_onnx import calib_images  # noqa: E402
from taxonomy import MOLD  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent


class Reader(CalibrationDataReader):
    def __init__(self, imgs):
        self.it = iter(imgs)

    def get_next(self):
        x = next(self.it, None)
        return None if x is None else {"image": x}


def agreement(path32: Path, path8: Path, imgs) -> dict:
    s32 = ort.InferenceSession(str(path32), providers=["CPUExecutionProvider"])
    s8 = ort.InferenceSession(str(path8), providers=["CPUExecutionProvider"])
    ag, mag, t32, t8 = [], [], 0.0, 0.0
    for x in imgs:
        t = time.time(); a = s32.run(None, {"image": x})[0]; t32 += time.time() - t
        t = time.time(); b = s8.run(None, {"image": x})[0]; t8 += time.time() - t
        pa, pb = a.argmax(1), b.argmax(1)
        ag.append(float((pa == pb).mean()))
        m = (pa == MOLD) | (pb == MOLD)
        if m.sum() > 10:
            mag.append(float(((pa == MOLD) == (pb == MOLD))[m].mean()))
    return {"pixel_agreement": round(float(np.mean(ag)), 4), "mold_agreement": round(float(np.mean(mag)), 4) if mag else None,
            "ms_fp32": round(1000 * t32 / len(imgs)), "ms_int8": round(1000 * t8 / len(imgs)), "mb": round(path8.stat().st_size / 1e6, 2)}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", default="v2")
    a = ap.parse_args()
    d = ROOT / "runs" / a.run
    fp32, pre = d / "berry-seg.fp32.onnx", d / "berry-seg.pre.onnx"
    quant_pre_process(str(fp32), str(pre), skip_symbolic_shape=True)
    calib = calib_images(64, 512)
    test = calib_images(40, 768)
    variants = {
        "qdq_per_channel_minmax": dict(per_channel=True, calibrate_method=CalibrationMethod.MinMax),
        "qdq_per_channel_percentile": dict(per_channel=True, calibrate_method=CalibrationMethod.Percentile, extra_options={"CalibPercentile": 99.99}),
        "qdq_conv_only_percentile": dict(per_channel=True, calibrate_method=CalibrationMethod.Percentile, op_types_to_quantize=["Conv"], extra_options={"CalibPercentile": 99.99}),
    }
    out = {}
    for name, kw in variants.items():
        p = d / f"q_{name}.onnx"
        quantize_static(str(pre), str(p), Reader(calib), quant_format=QuantFormat.QDQ, activation_type=QuantType.QUInt8, weight_type=QuantType.QInt8, **kw)
        out[name] = agreement(fp32, p, test)
        print(name, out[name], flush=True)
    p = d / "q_dynamic_weights.onnx"
    quantize_dynamic(str(pre), str(p), weight_type=QuantType.QInt8, op_types_to_quantize=["Conv"])
    out["dynamic_weights_only"] = agreement(fp32, p, test)
    print("dynamic_weights_only", out["dynamic_weights_only"], flush=True)
    (d / "quant.json").write_text(json.dumps(out, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
