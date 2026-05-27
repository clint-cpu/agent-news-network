#!/bin/bash
# ANN Performance Test Runner
# Usage: ./scripts/run-perf-tests.sh [output-dir]
#
# This script runs performance tests independently from the main test suite.
# It does NOT block CI — it's meant for manual or scheduled execution.

set -e

OUTPUT_DIR="${1:-./perf-reports}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
REPORT_FILE="$OUTPUT_DIR/perf-report-$TIMESTAMP.json"

# Ensure output directory exists
mkdir -p "$OUTPUT_DIR"

echo "=========================================="
echo "ANN Performance Test Suite"
echo "Timestamp: $TIMESTAMP"
echo "Output: $REPORT_FILE"
echo "=========================================="

# Run performance tests with vitest
# --reporter=json is not native to vitest, so we capture console output
echo ""
echo "[1/3] Running Gossip performance tests..."
npx vitest run src/__tests__/perf/gossip.perf.test.ts --reporter=verbose 2>&1 | tee "$OUTPUT_DIR/gossip-$TIMESTAMP.log"

echo ""
echo "[2/3] Running SQLite performance tests..."
npx vitest run src/__tests__/perf/db.perf.test.ts --reporter=verbose 2>&1 | tee "$OUTPUT_DIR/db-$TIMESTAMP.log"

echo ""
echo "[3/3] Running DHT performance tests..."
npx vitest run src/__tests__/perf/dht.perf.test.ts --reporter=verbose 2>&1 | tee "$OUTPUT_DIR/dht-$TIMESTAMP.log"

# Extract JSON reports from logs and merge
echo ""
echo "Extracting performance metrics..."

node -e "
const fs = require('fs');
const path = require('path');

const files = [
  'gossip-$TIMESTAMP.log',
  'db-$TIMESTAMP.log',
  'dht-$TIMESTAMP.log'
];

const results = {
  timestamp: '$TIMESTAMP',
  suite: 'ann-perf',
  tests: []
};

for (const file of files) {
  const logPath = path.join('$OUTPUT_DIR', file);
  if (!fs.existsSync(logPath)) continue;
  const content = fs.readFileSync(logPath, 'utf8');
  const matches = content.match(/\\[PERF-REPORT\\]\\s*(\\{[\\s\\S]*?\\})/g);
  if (matches) {
    for (const match of matches) {
      try {
        const json = match.replace('[PERF-REPORT]', '').trim();
        const report = JSON.parse(json);
        results.tests.push(report);
      } catch (e) {
        console.warn('Failed to parse report from', file);
      }
    }
  }
}

fs.writeFileSync('$REPORT_FILE', JSON.stringify(results, null, 2));
console.log('Merged report written to:', '$REPORT_FILE');
console.log('Tests captured:', results.tests.length);
"

echo ""
echo "=========================================="
echo "Performance tests complete!"
echo "Report: $REPORT_FILE"
echo "Logs: $OUTPUT_DIR/"
echo "=========================================="
