#!/usr/bin/env python3
"""Convert a single UpCloud docs HTML file to Markdown.

Extracts content from <article class=content> and strips breadcrumbs,
SVG icons, and changelog/popular-topics boxes. Keeps headings, prose,
lists, tables, code blocks, and images.

Usage:
    python3 convert_page.py <html_file> <output_md_file>
"""

import posixpath
import re
import sys
from pathlib import Path

from bs4 import BeautifulSoup, Tag
from markdownify import MarkdownConverter


def _normalise_href(href: str, html_dir: str) -> str:
    """Turn any href into a relative .md path.

    Works with both original absolute /docs/... hrefs and wget-rewritten
    relative paths like ../../guides/foo/index.html.
    """
    if not href or href.startswith("#") or href.startswith("mailto:"):
        return href
    if href.startswith("http://") or href.startswith("https://"):
        return href

    # Resolve relative paths to absolute using the HTML file's directory
    if not href.startswith("/"):
        href = posixpath.normpath(posixpath.join(html_dir, href))

    # Strip /index.html or .html suffix
    href = re.sub(r"/index\.html$", "", href)
    href = re.sub(r"\.html$", "", href)
    href = href.rstrip("/")

    # /docs or /docs/foo/bar  ->  foo/bar.md
    if href == "/docs" or href == "":
        return "/docs.md"
    rel = re.sub(r"^/docs/?", "", href)
    if rel:
        return "/docs/" + rel + ".md"
    return "/docs.md"


# ---------------------------------------------------------------------------
# Custom converter
# ---------------------------------------------------------------------------
class UpCloudConverter(MarkdownConverter):

    def __init__(self, *args, html_dir="", **kwargs):
        self.html_dir = html_dir
        super().__init__(*args, **kwargs)

    def convert_a(self, el, text, **kwargs):
        href = el.get("href", "")
        el["href"] = _normalise_href(href, self.html_dir)
        return super().convert_a(el, text, **kwargs)


def md(html, html_dir="", **kw):
    return UpCloudConverter(html_dir=html_dir, **kw).convert(html)


# ---------------------------------------------------------------------------
# Pre-processing: flatten card grids into clean link lists
# ---------------------------------------------------------------------------
def _flatten_cards(article: Tag, soup: BeautifulSoup):
    """Convert guide-card / feature-card grids into simple <ul> lists.

    These are <div class="guide-cards"> or similar wrappers containing
    <a class="guide-card"> blocks with title text + "Read more".
    """
    for container in article.select(
        ".guide-cards, .feature-cards, .popular-topics-list, .card-grid"
    ):
        items = container.find_all("a", recursive=True)
        if not items:
            continue
        ul = soup.new_tag("ul")
        for a_tag in items:
            # Extract just the meaningful title text (drop "Read more" etc.)
            text_parts = []
            for s in a_tag.stripped_strings:
                if s.lower() in ("read more", "learn more"):
                    continue
                text_parts.append(s)
            title = " — ".join(text_parts) if text_parts else a_tag.get_text(strip=True)
            href = a_tag.get("href", "")
            li = soup.new_tag("li")
            new_a = soup.new_tag("a", href=href)
            new_a.string = title
            li.append(new_a)
            ul.append(li)
        container.replace_with(ul)


# ---------------------------------------------------------------------------
# Post-processing / linting
# ---------------------------------------------------------------------------
def _lint_markdown(text: str) -> str:
    """Fix common markdown issues."""

    # 1. Fix multi-line links:  [foo\nbar](url)  ->  [foo bar](url)
    def _flatten_link(m):
        label = m.group(1)
        url = m.group(2)
        # Collapse whitespace inside the label
        label = re.sub(r"\s+", " ", label).strip()
        # Drop "Read more" / "Learn more" suffixes
        label = re.sub(r"\s*[-—]?\s*Read more$", "", label, flags=re.IGNORECASE)
        label = re.sub(r"\s*[-—]?\s*Learn more$", "", label, flags=re.IGNORECASE)
        return f"[{label}]({url})"

    text = re.sub(r"\[([^\]]*?\n[^\]]*?)\]\(([^)]+)\)", _flatten_link, text)

    # 2. Fix adjacent links with no spacing:  ](url)[next  ->  ](url)\n- [next
    text = re.sub(r"\)\]\(", ")\n- [", text)  # broken ][
    text = re.sub(r"(?<=\))\[", "\n- [", text)  # )[

    # 3. Collapse 3+ blank lines
    text = re.sub(r"\n{3,}", "\n\n", text)

    # 4. Remove trailing whitespace on lines
    text = re.sub(r"[ \t]+$", "", text, flags=re.MULTILINE)

    return text


# ---------------------------------------------------------------------------
# Main extraction
# ---------------------------------------------------------------------------
def convert_file(src: Path, dst: Path) -> bool:
    html = src.read_text(encoding="utf-8", errors="replace")
    soup = BeautifulSoup(html, "html.parser")

    article = soup.select_one("article.content")
    if article is None:
        article = soup.find("article")
    if article is None:
        print(f"  SKIP (no article): {src}", file=sys.stderr)
        return False

    # Compute the URL-space directory for this file (for resolving relative hrefs)
    # e.g.  .../upcloud.com/docs/products/foo/index.html  ->  /docs/products/foo
    src_str = str(src)
    m = re.search(r"/(docs/.*)$", src_str)
    if m:
        html_dir = "/" + str(Path(m.group(1)).parent)
    else:
        html_dir = ""

    # Remove elements we don't want in the markdown
    for sel in [
        ".breadcrumbs",
        "svg",
        ".latest-changelog",
        ".subheading-anchor",
        "script",
        "style",
        ".table-of-contents",
        ".toc",
        ".tutorial-meta-box",
        "nav",
    ]:
        for tag in article.select(sel):
            tag.decompose()

    # Flatten card grids into simple link lists
    _flatten_cards(article, soup)

    # Extract page title (h1)
    h1 = article.find("h1")
    title = h1.get_text(strip=True) if h1 else ""
    if h1:
        h1.decompose()

    # Convert to markdown
    body = md(str(article), html_dir=html_dir,
              heading_style="ATX", strip=["button", "span"],
              code_language="", bullets="-")

    # Lint / clean up
    body = _lint_markdown(body).strip()

    # Build final markdown
    lines = []
    if title:
        lines.append(f"# {title}")
        lines.append("")
    lines.append(body)
    lines.append("")  # trailing newline

    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_text("\n".join(lines), encoding="utf-8")
    return True


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} <html_file> <output_md>", file=sys.stderr)
        sys.exit(1)
    ok = convert_file(Path(sys.argv[1]), Path(sys.argv[2]))
    sys.exit(0 if ok else 1)
