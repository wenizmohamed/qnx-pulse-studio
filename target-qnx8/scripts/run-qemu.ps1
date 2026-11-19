# Launch QNX Neutrino 8.0 IFS image in QEMU x86_64 (Windows PowerShell)
param(
    [string]$IfsPath = "build\qnx8-pulse-x86_64.ifs",
    [int]$MemoryMB = 512,
    [int]$CpuCores = 2
)

if (-not (Test-Path $IfsPath)) {
    Write-Error "IFS image not found at '$IfsPath'. Build first with: make ifs"
    exit 1
}

Write-Host "[QNX Pulse] Booting QNX 8.0 instrumented kernel in QEMU x86_64..." -ForegroundColor Cyan
Write-Host "  IFS:  $IfsPath"
Write-Host "  RAM:  ${MemoryMB}MB | vCPUs: $CpuCores | Exit QEMU: Ctrl-A then X"

qemu-system-x86_64 `
    -machine q35 `
    -cpu max `
    -smp $CpuCores `
    -m $MemoryMB `
    -kernel $IfsPath `
    -nographic `
    -serial mon:stdio `
    -netdev user,id=net0,hostfwd=tcp::8022-:22 `
    -device virtio-net-pci,netdev=net0
