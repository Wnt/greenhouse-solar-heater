#!/usr/bin/env python3
"""Build a SUMMARY.md from the sidebar menu of any downloaded UpCloud docs page.

Parses <ul class=sidebar-menu> from the most recently modified HTML file and
produces markdown/SUMMARY.md — a nested list of links mirroring the sidebar.

Usage:
    python3 build_sidebar.py
"""

import re
import sys
from pathlib import Path

from bs4 import BeautifulSoup

ROOT = Path(__file__).parent
HTML_ROOT = ROOT / "upcloud.com" / "docs"
MD_ROOT = ROOT / "markdown"


def href_to_md_path(href: str, base_dir: str = "") -> str:
    """Convert an href (absolute or relative) to a markdown path.

    Handles both original /docs/... hrefs and wget-rewritten relative paths
    like ../../getting-started/index.html.
    """
    # Normalize wget-rewritten relative paths back to absolute
    if not href.startswith("/") and not href.startswith("http"):
        import posixpath
        href = posixpath.normpath(posixpath.join(base_dir, href))

    # Strip index.html suffix
    href = re.sub(r"/index\.html$", "", href)
    # Strip .html suffix
    href = re.sub(r"\.html$", "", href)
    href = href.rstrip("/")

    if href == "/docs" or href == "/docs/" or href == "":
        return "index.md"
    # Strip leading /docs/
    rel = re.sub(r"^/?docs/?", "", href)
    # Also handle paths that don't start with /docs (already relative)
    rel = rel.strip("/")
    return rel + ".md" if rel else "index.md"


def walk_ul(ul_tag, depth=0, base_dir=""):
    """Recursively walk <ul> -> <li> and yield (depth, title, md_path)."""
    if ul_tag is None:
        return
    for li in ul_tag.find_all("li", recursive=False):
        a = li.find("a", recursive=False) or li.select_one("span > a")
        if a is None:
            continue
        title = a.get_text(strip=True)
        href = a.get("href", "")
        md_path = href_to_md_path(href, base_dir)
        yield (depth, title, md_path)
        # Check for nested sub-menu
        for sub_ul in li.find_all("ul", recursive=False):
            yield from walk_ul(sub_ul, depth + 1, base_dir)
        # Also check inside hidden divs (sidebar-submenu-wrapper)
        for wrapper in li.select("div.sidebar-submenu-wrapper"):
            for sub_ul in wrapper.find_all("ul", recursive=False):
                yield from walk_ul(sub_ul, depth + 1, base_dir)


def build_summary():
    # Pick the largest HTML file (likely has the most complete sidebar)
    html_files = sorted(HTML_ROOT.rglob("index.html"), key=lambda p: p.stat().st_size, reverse=True)
    if not html_files:
        print("No HTML files found yet.", file=sys.stderr)
        sys.exit(1)

    best = html_files[0]
    print(f"Extracting sidebar from: {best}", file=sys.stderr)

    html = best.read_text(encoding="utf-8", errors="replace")
    soup = BeautifulSoup(html, "html.parser")

    sidebar = soup.select_one("ul.sidebar-menu")
    if sidebar is None:
        print("No ul.sidebar-menu found.", file=sys.stderr)
        sys.exit(1)

    # Compute base dir for resolving relative hrefs
    # e.g. upcloud.com/docs/products/block-storage/index.html -> /docs/products/block-storage
    rel_to_root = best.relative_to(ROOT / "upcloud.com")
    base_dir = "/" + str(rel_to_root.parent)  # e.g. /docs/products/block-storage

    lines = ["# UpCloud Documentation\n"]
    seen = set()
    for depth, title, md_path in walk_ul(sidebar, base_dir=base_dir):
        if md_path in seen:
            continue
        seen.add(md_path)
        indent = "  " * depth
        lines.append(f"{indent}- [{title}]({md_path})")

    MD_ROOT.mkdir(parents=True, exist_ok=True)
    out = MD_ROOT / "SUMMARY.md"
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"Wrote {out} ({len(seen)} entries)", file=sys.stderr)


if __name__ == "__main__":
    build_summary()
