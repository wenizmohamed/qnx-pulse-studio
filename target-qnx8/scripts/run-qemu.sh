#!/usr/bin/env sh
# Launch QNX Neutrino 8.0 IFS image in QEMU x86_64 (Linux / macOS)
set -eu

IFS_PATH="${1:-build/qnx8-pulse-x86_64.ifs}"
MEM_MB="${QNX_QEMU_MEM:-512}"
CPUS="${QNX_QEMU_CPUS:-2}"

if [ ! -f "$IFS_PATH" ]; then
    echo "Error: IFS image not found at '$IFS_PATH'. Run 'make ifs' first." >&2
    exit 1
fi

echo "[QNX Pulse] Booting QNX 8.0 instrumented kernel in QEMU x86_64..."
echo "  IFS:  $IFS_PATH | RAM: ${MEM_MB}MB | vCPUs: $CPUS | Exit: Ctrl-A X"

exec qemu-system-x86_64 \
    -machine q35 \
    -cpu max \
    -smp "$CPUS" \
    -m "$MEM_MB" \
    -kernel "$IFS_PATH" \
    -nographic \
    -serial mon:stdio \
    -netdev user,id=net0,hostfwd=tcp::8022-:22 \
    -device virtio-net-pci,netdev=net0
