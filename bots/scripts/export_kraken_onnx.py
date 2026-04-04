from __future__ import annotations

import argparse
import os
from pathlib import Path

import torch

ROOT = Path(__file__).resolve().parents[1] / "vendor" / "KrakenBot"
import sys
sys.path.insert(0, str(ROOT))

from model.resnet import HexResNet  # noqa: E402


class KrakenOnnxWrapper(torch.nn.Module):
    def __init__(self, model: HexResNet) -> None:
        super().__init__()
        self.model = model

    def forward(self, x: torch.Tensor):
        value, pair_logits, _moves_left, _chain = self.model(x)
        return value, pair_logits


def load_model(checkpoint: Path, device: torch.device) -> torch.nn.Module:
    ckpt = torch.load(checkpoint, map_location=device, weights_only=True)
    if isinstance(ckpt, dict) and "model_state_dict" in ckpt:
        state_dict = ckpt["model_state_dict"]
    else:
        state_dict = ckpt

    model = HexResNet()
    model.load_state_dict(state_dict, strict=False)
    model.eval()
    return KrakenOnnxWrapper(model).to(device)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("checkpoint")
    parser.add_argument("output")
    parser.add_argument("--opset", type=int, default=18)
    args = parser.parse_args()

    checkpoint = Path(args.checkpoint).expanduser().resolve()
    output = Path(args.output).expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)

    device = torch.device("cpu")
    model = load_model(checkpoint, device)
    model.eval()
    sample = torch.zeros(1, 2, 25, 25, device=device)

    torch.onnx.export(
        model,
        sample,
        output,
        input_names=["input"],
        output_names=["value", "pair_logits"],
        dynamic_axes={
            "input": {0: "batch", 2: "height", 3: "width"},
            "value": {0: "batch"},
            "pair_logits": {0: "batch", 1: "cells", 2: "cells"},
        },
        opset_version=args.opset,
        do_constant_folding=True,
    )

    print(output)


if __name__ == "__main__":
    main()
