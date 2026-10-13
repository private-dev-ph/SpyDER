"""Cloudflare build entry point: standard library only, no camera dependencies."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from spyder_cctv.showcase import export_showcase  # noqa: E402

if __name__ == "__main__":
    export_showcase(Path("dist/showcase"))
