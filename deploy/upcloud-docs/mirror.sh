#!/usr/bin/env bash
# Mirror the UpCloud documentation site and convert to Markdown.
#
# Usage:
#   ./mirror.sh            # full mirror + convert
#   ./mirror.sh --convert  # skip wget, just reconvert existing HTML

set -euo pipefail
cd "$(dirname "$0")"

CONVERT_ONLY=false
if [[ "${1:-}" == "--convert" ]]; then
    CONVERT_ONLY=true
fi

# --- Step 1: Mirror with wget ---
if [[ "$CONVERT_ONLY" == false ]]; then
    echo "==> Mirroring https://upcloud.com/docs/ ..."
    wget \
        --mirror \
        --convert-links \
        --adjust-extension \
        --page-requisites \
        --no-parent \
        --directory-prefix=. \
        --reject="*.js" \
        --wait=0.5 \
        --random-wait \
        --user-agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" \
        https://upcloud.com/docs/ \
    || echo "  (wget exited with $? — some pages may have failed, continuing)"
    echo ""
fi

# --- Step 2: Convert to Markdown ---
echo "==> Converting HTML to Markdown ..."
python3 convert_all.py --force

echo ""
echo "==> Done. Markdown files are in ./markdown/"
