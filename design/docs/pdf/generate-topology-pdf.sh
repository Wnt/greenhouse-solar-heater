#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
node design/docs/pdf/generate-topology-pdf.js
echo "PDF generated: design/docs/pdf/system-topology.pdf"
