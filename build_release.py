#!/usr/bin/env python3
"""Build a deterministic Chrome Web Store package for KakuSave.

Only runtime files are included. Docs, tests, CI config and local development
artifacts never enter the Store ZIP.
"""
from __future__ import annotations

import json
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DIST = ROOT / "dist"

RUNTIME_ROOTS = [ROOT / "icons", ROOT / "src"]
ROOT_FILES = [ROOT / "manifest.json"]
EXCLUDED_NAMES = {".DS_Store", "Thumbs.db"}
EXCLUDED_SUFFIXES = {".map", ".bak", ".tmp"}


def runtime_files() -> list[Path]:
    files: list[Path] = []
    for path in ROOT_FILES:
        if not path.is_file():
            raise SystemExit(f"missing runtime file: {path.relative_to(ROOT)}")
        files.append(path)
    for base in RUNTIME_ROOTS:
        if not base.is_dir():
            raise SystemExit(f"missing runtime directory: {base.relative_to(ROOT)}")
        for path in base.rglob("*"):
            if not path.is_file():
                continue
            if path.name in EXCLUDED_NAMES or path.suffix in EXCLUDED_SUFFIXES:
                continue
            files.append(path)
    return sorted(files, key=lambda p: p.relative_to(ROOT).as_posix())


def validate(files: list[Path]) -> tuple[str, str]:
    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("name") != "KakuSave - note本文バックアップ":
        raise SystemExit("unexpected manifest name")
    version = manifest.get("version")
    if version != "0.0.9":
        raise SystemExit(f"unexpected manifest version: {version}")

    rels = {p.relative_to(ROOT).as_posix() for p in files}
    required = {
        "manifest.json",
        "icons/icon16.png",
        "icons/icon32.png",
        "icons/icon48.png",
        "icons/icon128.png",
        "src/background/service-worker.js",
        "src/content/content.part1.js",
        "src/content/content.part2.js",
        "src/content/content.part3.js",
        "src/ui/history.html",
        "src/ui/history.css",
        "src/ui/history.js",
    }
    missing = required - rels
    if missing:
        raise SystemExit("missing package files: " + ", ".join(sorted(missing)))

    forbidden_prefixes = ("tests/", ".github/", "dist/")
    forbidden_files = {
        "README.md",
        "STORE_LISTING.md",
        "PRIVACY_POLICY.md",
        "LEGAL_TERMS.md",
        "RELEASE_CHECKLIST.md",
        "package.json",
        "package-lock.json",
    }
    bad = sorted(
        rel for rel in rels
        if rel.startswith(forbidden_prefixes) or rel in forbidden_files
    )
    if bad:
        raise SystemExit("development files leaked into package: " + ", ".join(bad))

    return manifest["name"], version


def build() -> Path:
    files = runtime_files()
    _name, version = validate(files)
    DIST.mkdir(exist_ok=True)
    output = DIST / f"KakuSave_v{version}.zip"
    temp = output.with_suffix(".tmp.zip")
    if temp.exists():
        temp.unlink()

    with zipfile.ZipFile(temp, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for path in files:
            rel = path.relative_to(ROOT).as_posix()
            info = zipfile.ZipInfo(rel, date_time=(2026, 8, 30, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            zf.writestr(info, path.read_bytes())

    temp.replace(output)
    with zipfile.ZipFile(output) as zf:
        names = set(zf.namelist())
        if "manifest.json" not in names:
            raise SystemExit("built ZIP has no root manifest.json")
        if any(n.startswith(("tests/", ".github/", "dist/")) for n in names):
            raise SystemExit("built ZIP contains development-only paths")
    return output


def main() -> None:
    if "--check" in sys.argv:
        files = runtime_files()
        name, version = validate(files)
        print(f"release package check: OK ({name} v{version}, {len(files)} runtime files)")
        return
    output = build()
    print(output.relative_to(ROOT).as_posix())


if __name__ == "__main__":
    main()
