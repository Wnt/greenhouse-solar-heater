#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
node design/docs/pdf/generate-pdf.js
echo "PDF generated: design/docs/pdf/commissioning-guide.pdf"
