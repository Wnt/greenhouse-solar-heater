# UpCloud Docs Mirror

Offline mirror of [UpCloud documentation](https://upcloud.com/docs/) with automatic HTML-to-Markdown conversion.

## Quick start

```bash
# Full mirror + convert (takes a while on first run)
./mirror.sh

# Re-convert existing HTML without re-downloading
./mirror.sh --convert
```

## Directory structure

```
.
├── mirror.sh              # Main entry point — mirrors site & converts
├── convert_all.py         # Batch converter — finds & converts all HTML files
├── convert_page.py        # Single-file converter (article.content → Markdown)
├── build_sidebar.py       # Builds SUMMARY.md from ul.sidebar-menu
├── lint_markdown.py       # Lints & auto-fixes converted Markdown
├── upcloud.com/docs/      # Raw HTML mirror (created by wget)
└── markdown/              # Converted Markdown output
    ├── SUMMARY.md         # Table of contents from sidebar navigation
    ├── index.md           # Docs landing page
    ├── getting-started/   # Getting started guides
    ├── products/          # Product documentation
    ├── guides/            # How-to guides
    ├── tooling/           # API, CLI, Terraform, etc.
    └── changelog/         # Changelog entries
```

## Requirements

- Python 3.8+
- `wget`
- Python packages: `beautifulsoup4`, `markdownify`

```bash
pip install beautifulsoup4 markdownify
```

## Scripts

### `mirror.sh`

Runs `wget` to mirror the site, then calls `convert_all.py`. Pass `--convert` to skip the download step.

### `convert_all.py`

Converts all `index.html` files under `upcloud.com/docs/` to Markdown in the `markdown/` directory. Skips files where the Markdown is already newer than the HTML source. Use `--force` to reconvert everything.

After conversion it rebuilds `SUMMARY.md` and runs the linter with auto-fix.

### `convert_page.py`

Converts a single HTML file. Extracts `<article class=content>`, strips navigation chrome (breadcrumbs, SVGs, changelog boxes), flattens guide-card grids into clean link lists, and rewrites all internal links to `.md` paths.

### `build_sidebar.py`

Parses the `<ul class=sidebar-menu>` from the largest HTML file to generate `markdown/SUMMARY.md` — a nested table of contents matching the site's sidebar navigation.

### `lint_markdown.py`

Checks for and optionally fixes common issues:

- Multi-line link labels
- Links pointing to `.html` instead of `.md`
- Adjacent links with no separator
- Bare "Read more" text
- Excessive blank lines

```bash
python3 lint_markdown.py          # report only
python3 lint_markdown.py --fix    # auto-fix
```

## Updating

Re-run `./mirror.sh` to fetch new/changed pages. `wget --mirror` only downloads files that have changed on the server. `convert_all.py` only reconverts files where the HTML is newer than the existing Markdown.
