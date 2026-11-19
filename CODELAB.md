# QNX 8.0 Hands-On Codelab: Catching & Fixing Real-Time Priority Inversion with QNX Pulse Studio

**Duration:** ~35 minutes  
**Level:** Intermediate Embedded / Real-Time Systems  
**Target Platform:** QNX Neutrino 8.0 (`x86_64` on QEMU or Raspberry Pi 4 / x86 hardware)  
**Interactive Web Edition:** Open [`/codelab.html`](./public/codelab.html) for progress tracking, 1-click command copy, and interactive Before/After code diffing.

---

## What You Will Build & Learn

By completing this 7-step codelab, you will:
1. Verify your **QNX Software Development Platform (SDP) 8.0** cross-compilation toolchain (`qcc`, `mkifs`).
2. Compile a genuine two-process QNX 8.0 real-time system (`sensor_broker` + `motor_ctrl`) using `name_attach()`, `MsgReceive()`/`MsgReply()`, `MsgSendPulse()`, `ClockCycles()`, `SCHED_FIFO`, `slog2f()`, and `/pps/qnx/telemetry`.
3. Assemble a bootable QNX 8.0 **Image Filesystem (IFS)** running the instrumented microkernel (`procnto-smp-instr`).
4. Boot QNX 8.0 on **QEMU x86_64** and inspect live thread scheduling (`pidin`) and PPS telemetry (`/pps/qnx/telemetry`).
5. Trigger a real **Priority Inversion** (`--inject-inversion`) that blows a 500 us hard-RT control deadline (spiking to 1,842 us) and capture `slog2info`, `pidin`, `tracelogger` + `traceprinter`, and `/pps` dumps.
6. Audit the capture bundle with **`qnx-pulse`** (CLI + visual Oscilloscope Workbench) to pinpoint exact PID/TID/priority contention and trigger CI failure (`exit 2`).
7. Fix the root cause with **`PTHREAD_PRIO_INHERIT`** (`--fixed-pi`), cutting worst-case control jitter by **93.9%** (`1,842.4 us -> 112.6 us`), and verify CI pass (`exit 0`).

---

## Step 1: Initialize QNX SDP 8.0 Environment & Verify Toolchain

Source your QNX SDP 8.0 environment so `QNX_HOST`, `QNX_TARGET`, `qcc`, and `mkifs` are on your `PATH`.

**Linux / macOS:**
```bash
source ~/qnx800/qnxsdp-env.sh
qcc -V
which mkifs qemu-system-x86_64
```

**Windows (PowerShell / CMD):**
```powershell
cmd /c "C:\qnx800\qnxsdp-env.bat && qcc -V && where mkifs"
```

Verify `gcc_ntox86_64` appears in the `qcc -V` target list. (No SDP installed yet? You can jump straight to Steps 6-7 using the real captured QNX 8.0 sample bundles in `samples/`.)

---

## Step 2: Build the QNX 8.0 C11 Real-Time Target (`sensor_broker` & `motor_ctrl`)

Inspect [`target-qnx8/src/sensor_broker.c`](./target-qnx8/src/sensor_broker.c) and [`target-qnx8/src/motor_ctrl.c`](./target-qnx8/src/motor_ctrl.c):
- `sensor_broker` attaches `qnx/pulse/sensor_broker` via `name_attach()`, services synchronous `MsgReceive()`/`MsgReply()` frames at `SCHED_FIFO` prio 55, emits `MsgSendPulse()`, logs with `slog2f()`, and publishes live readings to `/pps/qnx/telemetry`.
- `motor_ctrl` spawns three `SCHED_FIFO` threads:
  - `actuator_1khz` (**prio 60f**) — 1 kHz hard-RT control loop (`500 us` deadline jitter budget)
  - `diag_streamer` (**prio 35f**) — bursty 1.4 ms CPU-bound telemetry compression
  - `calib_worker` (**prio 15f**) — updates a shared calibration table protected by `g_calib_mtx`

Cross-compile both binaries for QNX 8.0 x86_64 using `Makefile` or `CMake`:

```bash
cd target-qnx8
make all
```

Or with CMake + QNX 8.0 toolchain file:
```bash
cmake -B build -DCMAKE_TOOLCHAIN_FILE=qnx8-toolchain.cmake
cmake --build build
```

---

## Step 3: Assemble a Bootable QNX 8.0 Instrumented IFS Image (`mkifs`)

Our buildfile [`target-qnx8/qnx8-qemu-x86_64.build`](./target-qnx8/qnx8-qemu-x86_64.build) boots `procnto-smp-instr` (the instrumented Neutrino 8.0 kernel required for microsecond-accurate `tracelogger` event capture), starts `slogger2`, `pps`, `devc-ser8250`, and launches `sensor_broker --prio 55`.

```bash
cd target-qnx8
make ifs
ls -lh build/qnx8-pulse-x86_64.ifs
```

---

## Step 4: Boot QNX 8.0 on QEMU x86_64 & Verify Live IPC + PPS

Launch the IFS image in QEMU:

```bash
# Linux / macOS
sh target-qnx8/scripts/run-qemu.sh target-qnx8/build/qnx8-pulse-x86_64.ifs

# Windows PowerShell
pwsh -File target-qnx8/scripts/run-qemu.ps1 -IfsPath target-qnx8/build/qnx8-pulse-x86_64.ifs
```

Once the QNX 8.0 `ksh` prompt appears, verify `sensor_broker` is running in `RECEIVE` state at `55f` and check `/pps/qnx/telemetry`:

```sh
pidin -F "%a %b %p %J %S %h"
cat /pps/qnx/telemetry
slog2info | tail -n 10
```

---

## Step 5: Reproduce a Real Priority Inversion & Capture Target Diagnostics

Run `motor_ctrl --inject-inversion`, which initializes `g_calib_mtx` with `PTHREAD_PRIO_NONE`. When `calib_worker (15f)` holds the mutex and `actuator_1khz (60f)` blocks on it, `diag_streamer (35f)` preempts `calib_worker` for ~1.4 ms — stalling the highest-priority thread in the system!

Inside the QNX 8.0 shell:
```sh
/proc/boot/motor_ctrl --inject-inversion --iterations 200 &
/proc/boot/capture-diag.sh /tmp/capture-inversion 3
```

`capture-diag.sh` records four synchronized QNX 8.0 artifacts into `/tmp/capture-inversion`:
- `trace.csv` (`tracelogger -s 3 -f kernel.kev` decoded via `traceprinter`)
- `pidin.txt` (`pidin -F "%a %b %p %J %S %h"`)
- `slog2.log` (`slog2info`)
- `pps_telemetry.pps` (`/pps/qnx/telemetry`)

Copy `/tmp/capture-inversion` back to your host (or use our pre-captured `samples/brake-ecu-inversion/`).

---

## Step 6: Diagnose with `qnx-pulse` CLI & Visual Oscilloscope Workbench

Run the cross-platform QNX Pulse Studio host CLI against the captured bundle:

```bash
node cli/qnx-pulse.mjs analyze samples/brake-ecu-inversion --deadline 500
echo "CI Exit Code: $?"
```

Expected result:
- **Verdict:** `RT VIOLATION FAIL (EXIT 2)`
- **Priority Inversions:** `1` (`1,380 us` inversion window: `actuator_1khz[p60]` blocked on `calib_worker[p15]` while `diag_streamer[p35]` preempted CPU0)
- **Max Jitter:** `1,842.4 us` vs `500 us` budget
- **Blocked IPC Chain:** `actuator_1khz[p60] -> calib_worker[p15]` and `ipc_broker[p55] -> can0_rx_tx[p50]`

Open the interactive web workbench (`npm run dev` -> `http://127.0.0.1:4173/`) and select **Brake ECU - Priority Inversion** to visually inspect the crimson inversion band on the SVG `SCHED_FIFO` timeline, filter `slog2` error lines, and explore the `/pps/qnx/telemetry` object tree.

---

## Step 7: Fix with `PTHREAD_PRIO_INHERIT` & Verify CI Gate (`EXIT 0`)

The single-line root-cause fix in `target-qnx8/src/motor_ctrl.c`:

```diff
 pthread_mutexattr_t mattr;
 pthread_mutexattr_init(&mattr);
-pthread_mutexattr_setprotocol(&mattr, PTHREAD_PRIO_NONE);
+pthread_mutexattr_setprotocol(&mattr, PTHREAD_PRIO_INHERIT);
 pthread_mutex_init(&g_calib_mtx, &mattr);
```

When `PTHREAD_PRIO_INHERIT` is active, the QNX Neutrino 8.0 microkernel automatically boosts `calib_worker` from `15f` to `60f` the instant `actuator_1khz (60f)` contends on `g_calib_mtx`. Medium-priority `diag_streamer (35f)` can no longer preempt it.

Run with `--fixed-pi` on target, recapture, and re-audit:

```bash
# On QNX 8.0 target:
/proc/boot/motor_ctrl --fixed-pi --iterations 200 &
/proc/boot/capture-diag.sh /tmp/capture-fixed 3

# On host / CI runner:
node cli/qnx-pulse.mjs analyze samples/surgical-arm-clean --deadline 500
echo "CI Exit Code: $?"
```

| Metric | Before (`--inject-inversion`) | After (`--fixed-pi`) | Delta |
| --- | ---: | ---: | ---: |
| Mutex Protocol | `PTHREAD_PRIO_NONE` | `PTHREAD_PRIO_INHERIT` | Kernel PI Active |
| Priority Inversions | `1` (`1,380 us`) | `0` | **-100%** |
| Max Control Jitter | `1,842.4 us` | `112.6 us` | **-93.9%** |
| Deadline Violations (`>500us`) | `2` | `0` | **-100%** |
| CI Exit Code | `2` (`FAIL`) | `0` (`PASS`) | **Green Pipeline** |

Add `node cli/qnx-pulse.mjs analyze ./rt-capture --deadline 500 --format markdown --out rt-audit.md` to your GitHub Actions / GitLab CI hardware-in-the-loop (HIL) stage so no priority inversion ever ships to production.
