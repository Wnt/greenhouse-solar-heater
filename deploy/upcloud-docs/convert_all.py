#!/usr/bin/env python3
"""Convert all downloaded UpCloud docs HTML files to Markdown.

Safe to run while wget is still mirroring — it processes whatever HTML files
exist at the time and skips files that are already up-to-date. Re-run it
periodically or after wget finishes to pick up new pages.

Usage:
    python3 convert_all.py           # convert all, skip up-to-date
    python3 convert_all.py --force   # reconvert everything
"""

import os
import platform
import subprocess
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).parent
HTML_ROOT = ROOT / "upcloud.com" / "docs"
MD_ROOT = ROOT / "markdown"

WORKERS = os.cpu_count() + 4


def _print_system_info():
    cpu_count = os.cpu_count()
    arch = platform.machine()
    try:
        mem_bytes = os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES")
        mem_gb = mem_bytes / (1024 ** 3)
        mem_str = f"{mem_gb:.1f} GB"
    except (ValueError, OSError, AttributeError):
        # macOS doesn't support SC_PHYS_PAGES; fall back to sysctl
        try:
            out = subprocess.check_output(["sysctl", "-n", "hw.memsize"], text=True)
            mem_gb = int(out.strip()) / (1024 ** 3)
            mem_str = f"{mem_gb:.1f} GB"
        except Exception:
            mem_str = "unknown"
    print(f"System: {arch}, {cpu_count} CPUs, {mem_str} RAM")


def _html_to_md_path(html_path: Path) -> Path:
    """Map upcloud.com/docs/foo/bar/index.html -> markdown/foo/bar.md"""
    rel = html_path.parent.relative_to(HTML_ROOT)
    if str(rel) == ".":
        return MD_ROOT / "index.md"
    return MD_ROOT / (str(rel) + ".md")


def _convert_one(args: tuple) -> tuple:
    """Worker function — import locally to avoid pickling issues."""
    src, dst = args
    from convert_page import convert_file
    try:
        ok = convert_file(Path(src), Path(dst))
        return (dst, ok, None)
    except Exception as e:
        return (dst, False, str(e))


def main():
    _print_system_info()
    force = "--force" in sys.argv

    html_files = sorted(HTML_ROOT.rglob("index.html"))
    if not html_files:
        print("No HTML files found yet. Is wget still running?")
        return

    # Build work list, filtering out up-to-date files
    work = []
    skipped = 0
    for html_path in html_files:
        md_path = _html_to_md_path(html_path)
        if not force and md_path.exists():
            if md_path.stat().st_mtime >= html_path.stat().st_mtime:
                skipped += 1
                continue
        work.append((str(html_path), str(md_path)))

    if not work:
        print(f"Nothing to do: {skipped} files already up-to-date")
        print(f"Total HTML files found: {len(html_files)}")
        return

    print(f"Converting {len(work)} files using {WORKERS} workers "
          f"({skipped} already up-to-date) ...")
    t0 = time.monotonic()

    converted = 0
    failed = 0
    with ProcessPoolExecutor(max_workers=WORKERS) as pool:
        futures = {pool.submit(_convert_one, item): item for item in work}
        for future in as_completed(futures):
            dst, ok, err = future.result()
            if ok:
                converted += 1
            else:
                failed += 1
                if err:
                    print(f"  FAIL {dst}: {err}", file=sys.stderr)

    elapsed = time.monotonic() - t0
    print(f"\nDone in {elapsed:.1f}s: {converted} converted, "
          f"{skipped} up-to-date, {failed} failed")
    print(f"Total HTML files found: {len(html_files)}")

    # Build/update sidebar summary
    print("\nBuilding SUMMARY.md from sidebar menu...")
    subprocess.run([sys.executable, str(ROOT / "build_sidebar.py")])

    # Lint and auto-fix
    print("\nLinting markdown files...")
    subprocess.run([sys.executable, str(ROOT / "lint_markdown.py"), "--fix"])
    print("\nRe-checking for remaining issues...")
    subprocess.run([sys.executable, str(ROOT / "lint_markdown.py")])


if __name__ == "__main__":
    main()
