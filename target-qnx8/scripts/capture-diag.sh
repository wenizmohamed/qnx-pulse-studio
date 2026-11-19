#!/bin/sh
# QNX Pulse Studio - Target Diagnostic Capture Script (runs on QNX 8.0 target)
# Captures slog2info, pidin thread/priority table, tracelogger/traceprinter CSV, and /pps dumps.
set -eu

OUT_DIR="${1:-/tmp/qnx-pulse-capture}"
TRACE_SECONDS="${2:-3}"
mkdir -p "$OUT_DIR"

echo "[QNX Pulse] Capturing QNX 8.0 diagnostics into $OUT_DIR ..."

# 1. Capture instrumented kernel trace (.kev) and decode with traceprinter
echo "  [1/4] Recording kernel trace (${TRACE_SECONDS}s) via tracelogger..."
tracelogger -s "$TRACE_SECONDS" -f "$OUT_DIR/kernel.kev" -M -F 1 || true
if [ -f "$OUT_DIR/kernel.kev" ]; then
    traceprinter -f "$OUT_DIR/kernel.kev" -o "$OUT_DIR/trace.csv" || true
fi

# 2. Capture pidin thread priorities, policies, states, and blocked-on targets
echo "  [2/4] Capturing pidin -F \"%a %b %p %J %S %h\"..."
pidin -F "%a %b %p %J %S %h" > "$OUT_DIR/pidin.txt"

# 3. Capture slog2info structured logs
echo "  [3/4] Capturing slog2info..."
slog2info > "$OUT_DIR/slog2.log"

# 4. Capture /pps/qnx/telemetry PPS object state
echo "  [4/4] Capturing /pps/qnx/telemetry..."
if [ -r /pps/qnx/telemetry ]; then
    cat /pps/qnx/telemetry > "$OUT_DIR/pps_telemetry.pps"
else
    printf "@telemetry\nstatus:s:PPS_UNAVAILABLE\n" > "$OUT_DIR/pps_telemetry.pps"
fi

echo "[QNX Pulse] Capture complete. Copy $OUT_DIR to host and run:"
echo "  npx qnx-pulse analyze $OUT_DIR --deadline 500"
