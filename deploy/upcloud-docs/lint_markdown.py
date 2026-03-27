#!/usr/bin/env python3
"""Lint all converted markdown files and report issues.

Usage:
    python3 lint_markdown.py              # report only
    python3 lint_markdown.py --fix        # fix what can be auto-fixed
"""

import re
import sys
from pathlib import Path

MD_ROOT = Path(__file__).parent / "markdown"


def lint_file(path: Path, fix: bool = False):
    """Return list of (line_no, issue_description) for a file."""
    text = path.read_text(encoding="utf-8")
    issues = []

    # 1. Multi-line links:  [text\nmore](url)
    for m in re.finditer(r"\[[^\]]*\n[^\]]*\]\(", text):
        lineno = text[:m.start()].count("\n") + 1
        issues.append((lineno, "multi-line link label"))

    # 2. Links pointing to .html instead of .md
    for m in re.finditer(r"\]\([^)]*\.html[^)]*\)", text):
        lineno = text[:m.start()].count("\n") + 1
        issues.append((lineno, f"link to .html: {m.group()[:60]}"))

    # 3. Adjacent links with no separator: ](url)[
    for m in re.finditer(r"\)\[", text):
        # Check it's not inside a code block
        lineno = text[:m.start()].count("\n") + 1
        line = text.splitlines()[lineno - 1] if lineno <= len(text.splitlines()) else ""
        if not line.strip().startswith("`"):
            issues.append((lineno, "adjacent links with no separator"))

    # 4. Bare "Read more" or "Learn more" lines
    for i, line in enumerate(text.splitlines(), 1):
        stripped = line.strip()
        if stripped.lower() in ("read more", "learn more"):
            issues.append((i, f"bare '{stripped}' text"))

    # 5. 3+ consecutive blank lines
    for m in re.finditer(r"\n{4,}", text):
        lineno = text[:m.start()].count("\n") + 1
        issues.append((lineno, "excessive blank lines"))

    if fix and issues:
        fixed = text
        # Fix multi-line links
        def _flatten_link(m):
            label = re.sub(r"\s+", " ", m.group(1)).strip()
            label = re.sub(r"\s*[-—]?\s*Read more$", "", label, flags=re.IGNORECASE)
            label = re.sub(r"\s*[-—]?\s*Learn more$", "", label, flags=re.IGNORECASE)
            return f"[{label}]({m.group(2)})"
        fixed = re.sub(r"\[([^\]]*?\n[^\]]*?)\]\(([^)]+)\)", _flatten_link, fixed)
        # Fix adjacent links
        fixed = re.sub(r"(?<=\))\[", "\n- [", fixed)
        # Fix .html links
        fixed = re.sub(r"(/index)\.html", "", fixed)
        fixed = re.sub(r"\.html", ".md", fixed)
        # Fix excessive blanks
        fixed = re.sub(r"\n{4,}", "\n\n", fixed)
        # Fix bare read more
        fixed = re.sub(r"^[ \t]*Read more[ \t]*$", "", fixed, flags=re.MULTILINE | re.IGNORECASE)
        fixed = re.sub(r"^[ \t]*Learn more[ \t]*$", "", fixed, flags=re.MULTILINE | re.IGNORECASE)

        if fixed != text:
            path.write_text(fixed, encoding="utf-8")

    return issues


def main():
    fix = "--fix" in sys.argv
    total_issues = 0
    files_with_issues = 0

    for md_path in sorted(MD_ROOT.rglob("*.md")):
        issues = lint_file(md_path, fix=fix)
        if issues:
            files_with_issues += 1
            total_issues += len(issues)
            rel = md_path.relative_to(MD_ROOT)
            for lineno, desc in issues[:5]:  # cap per file
                print(f"  {rel}:{lineno}: {desc}")
            if len(issues) > 5:
                print(f"  {rel}: ... and {len(issues) - 5} more")

    action = "fixed" if fix else "found"
    print(f"\n{total_issues} issues {action} in {files_with_issues} files")
    if not fix and total_issues > 0:
        print("Run with --fix to auto-fix")


if __name__ == "__main__":
    main()
