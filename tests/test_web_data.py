"""The browser app reads its stopwords, types and studies from web/data.

Those files are exported from this package, so they go stale the moment a list
here changes and nobody reruns the export. The browser would then quietly
disagree with the package it mirrors. This test is what notices.
"""

import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _exporter():
    spec = importlib.util.spec_from_file_location(
        "export_web_data", ROOT / "scripts" / "export_web_data.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_web_data_matches_the_package():
    ex = _exporter()
    stale = [name for name, data in ex.payloads().items()
             if (ROOT / "web" / "data" / name).read_text(encoding="utf-8") != ex.render(data)]
    assert not stale, f"rerun scripts/export_web_data.py: {', '.join(stale)} out of date"
