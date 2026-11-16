"""Легка сегментаційна мережа для браузера: MobileNetV3-small (torchvision, BSD-3) + мала «голова» FPN.

Вихід — логіти класів на сітці з кроком 4 px. Мережа повністю згорткова: розмір входу довільний (кратний 32).
Близько 1,1 млн параметрів: ~4,5 МБ у float32, ~1,3 МБ після квантизації до int8.
Навчальний код не прив'язаний до архітектури: достатньо замінити build_model().
"""
from __future__ import annotations

import torch
import torch.nn as nn
import torch.nn.functional as F
from torchvision.models import MobileNet_V3_Small_Weights, mobilenet_v3_small

from taxonomy import NUM_CLASSES

MEAN = (0.485, 0.456, 0.406)
STD = (0.229, 0.224, 0.225)
STRIDE = 4            # крок вихідної сітки
MULTIPLE = 32         # розмір входу має бути кратний цьому


def dsconv(cin: int, cout: int) -> nn.Sequential:
    """Роздільна згортка 3×3: дешева заміна звичайної."""
    return nn.Sequential(
        nn.Conv2d(cin, cin, 3, padding=1, groups=cin, bias=False), nn.BatchNorm2d(cin), nn.ReLU(inplace=True),
        nn.Conv2d(cin, cout, 1, bias=False), nn.BatchNorm2d(cout), nn.ReLU(inplace=True),
    )


class BerrySeg(nn.Module):
    def __init__(self, num_classes: int = NUM_CLASSES, width: int = 48, pretrained: bool = True):
        super().__init__()
        weights = MobileNet_V3_Small_Weights.IMAGENET1K_V1 if pretrained else None
        f = mobilenet_v3_small(weights=weights).features
        # відводи: крок 4 (16 каналів), 8 (24), 16 (48), 32 (96)
        self.s4, self.s8, self.s16, self.s32 = f[0:2], f[2:4], f[4:9], f[9:12]
        self.lat = nn.ModuleList([nn.Conv2d(c, width, 1) for c in (16, 24, 48, 96)])
        self.smooth = nn.ModuleList([dsconv(width, width) for _ in range(3)])
        self.head = nn.Sequential(dsconv(width, width), nn.Conv2d(width, num_classes, 1))
        # нормалізація всередині мережі: у браузер подаються просто пікселі 0..1
        self.register_buffer("mean", torch.tensor(MEAN).view(1, 3, 1, 1))
        self.register_buffer("std", torch.tensor(STD).view(1, 3, 1, 1))

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = (x - self.mean) / self.std
        c2 = self.s4(x)
        c3 = self.s8(c2)
        c4 = self.s16(c3)
        c5 = self.s32(c4)
        p = self.lat[3](c5)
        for i, c in zip((2, 1, 0), (c4, c3, c2)):
            p = self.smooth[i](self.lat[i](c) + F.interpolate(p, size=c.shape[-2:], mode="nearest"))
        return self.head(p)


def build_model(pretrained: bool = True) -> nn.Module:
    return BerrySeg(pretrained=pretrained)


if __name__ == "__main__":
    m = build_model(pretrained=False).eval()
    n = sum(p.numel() for p in m.parameters())
    y = m(torch.zeros(1, 3, 384, 512))
    print(f"параметрів: {n / 1e6:.2f} млн · вихід: {tuple(y.shape)}")
