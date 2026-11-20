/**
 * QNX Pulse Studio - Built-in Authentic QNX Neutrino 8.0 Diagnostic Capture Presets
 * Mirrors the sample capture bundles in `samples/`.
 * SPDX-License-Identifier: MIT
 */

export const PRESETS = {
  'brake-ecu-inversion': {
    id: 'brake-ecu-inversion',
    label: 'Brake ECU - Priority Inversion',
    badge: 'RT VIOLATION',
    description:
      'Automotive ADAS Brake ECU running motor_ctrl --inject-inversion (PTHREAD_PRIO_NONE). High-priority actuator_1khz (60f) blocks on calib_worker (15f) while diag_streamer (35f) preempts CPU0 for 1,380 us, driving control jitter to 1,842.4 us.',
    meta: {
      name: 'Automotive Brake ECU (PTHREAD_PRIO_NONE Inversion)',
      target: 'x86_64-neutrino-8.0 (procnto-smp-instr)',
      mode: '--inject-inversion'
    },
    pidin: `PID   TID   PROCESS         PRIO  STATE     BLOCKED   THREAD_NAME
4102  3     motor_ctrl      60f   MUTEX     4102:1    actuator_1khz
4098  1     sensor_broker   55f   REPLY     4095:1    ipc_broker
4095  1     can_bus_drv     50f   RUNNING   -         can0_rx_tx
4102  2     motor_ctrl      35f   RUNNING   -         diag_streamer
4102  1     motor_ctrl      15f   READY     -         calib_worker
4010  1     slogger2        21r   RECEIVE   1         slogger2_main
4012  1     pps             21r   RECEIVE   1         pps_server`,
    slog2: `Nov 19 11:20:00.010  sensor_broker.4098  1000  5  sensor_broker online pid=4098 chid=1 prio=55f cycles_per_sec=2400000000
Nov 19 11:20:00.045  motor_ctrl.4102     2000  5  motor_ctrl starting pid=4102 mode=--inject-inversion mutex_protocol=PTHREAD_PRIO_NONE
Nov 19 11:20:00.120  motor_ctrl.4102     2005  5  RT_TICK iter=25 jitter_us=98.4 brake_kpa=4285 pi=PRIO_NONE
Nov 19 11:20:00.370  motor_ctrl.4102     2005  5  RT_TICK iter=50 jitter_us=114.2 brake_kpa=4310 pi=PRIO_NONE
Nov 19 11:20:00.512  can_bus_drv.4095    3101  3  CAN0 frame arbitration retry count=2 bus_load=74%
Nov 19 11:20:00.624  motor_ctrl.4102     2010  2  DEADLINE_VIOLATION iter=75 jitter_us=1842.4 budget_us=500.0 pi=PRIO_NONE
Nov 19 11:20:00.625  sensor_broker.4098  1005  3  High IPC reply latency detected pid=4102 tid=3 ipc_us=612.8
Nov 19 11:20:00.880  motor_ctrl.4102     2010  2  DEADLINE_VIOLATION iter=100 jitter_us=1615.0 budget_us=500.0 pi=PRIO_NONE
Nov 19 11:20:01.050  motor_ctrl.4102     2099  2  motor_ctrl summary mode=INJECT_INVERSION max_jitter_us=1842.4 violations=2/200`,
    trace: `time_us,cpu,class,event,pid,tid,prio,target_pid,target_tid,detail
0,0,THREAD,THRUNNING,4102,1,15,-,-,calib_worker acquires g_calib_mtx (PTHREAD_PRIO_NONE)
45,0,THREAD,THRUNNING,4102,3,60,-,-,actuator_1khz wakes on 1kHz monotonic timer
60,0,COMM,MSG_SENDV,4102,3,60,4098,1,MSG_TYPE_READ_SENSOR seq=75
65,1,THREAD,THRUNNING,4098,1,55,-,-,sensor_broker receives READ_SENSOR
80,1,COMM,MSG_SENDV,4098,1,55,4095,1,CAN_READ_PRESSURE frame=0x214
90,1,THREAD,THRUNNING,4095,1,50,-,-,can_bus_drv reads hydraulic sensor
135,1,COMM,MSG_REPLYV,4095,1,50,4098,1,brake_pressure_kpa=4340
150,1,COMM,MSG_REPLYV,4098,1,55,4102,3,SENSOR_VALID status=0x1
165,1,COMM,MSG_PULSE,4098,1,55,4012,1,PULSE_CODE_SENSOR_READY seq=75
175,0,THREAD,THRUNNING,4102,3,60,-,-,actuator_1khz attempts pthread_mutex_lock(g_calib_mtx)
190,0,SYNC,THMUTEX,4102,3,60,4102,1,Blocked on g_calib_mtx held by calib_worker(4102:1)
205,0,THREAD,THREADY,4102,1,15,-,-,calib_worker preempted before unlocking g_calib_mtx
210,0,THREAD,THRUNNING,4102,2,35,-,-,diag_streamer CPU compression burst preempts prio 15
1590,0,THREAD,THNANOSLEEP,4102,2,35,-,-,diag_streamer finishes burst and sleeps 3ms
1600,0,THREAD,THRUNNING,4102,1,15,-,-,calib_worker resumes after 1395us starvation
1690,0,SYNC,MUTEX_UNLOCK,4102,1,15,-,-,calib_worker releases g_calib_mtx
1705,0,THREAD,THRUNNING,4102,3,60,-,-,actuator_1khz unblocked jitter_us=1842.4
1890,0,THREAD,THNANOSLEEP,4102,3,60,-,-,actuator_1khz sleeps for next 1kHz tick
1900,1,THREAD,THRECEIVE,4098,1,55,-,-,sensor_broker idle in MsgReceive()`,
    pps: `@telemetry
seq:n:75
brake_pressure_kpa:n:4340
imu_yaw_mdeg:n:-42
temp_mC:n:42150
ipc_service_us:n:612.80
status:s:DEGRADED_LATENCY

@brake_ecu
mode:s:INJECT_INVERSION
mutex_protocol:s:PTHREAD_PRIO_NONE
max_jitter_us:n:1842.4
deadline_budget_us:n:500.0
inversion_detected:b:true
active_faults:json:["PRIORITY_INVERSION","DEADLINE_EXCEEDED"]`
  },

  'surgical-arm-clean': {
    id: 'surgical-arm-clean',
    label: 'Surgical Arm - Fixed PI (Clean)',
    badge: 'RT PASS',
    description:
      '6-DOF Robotic Surgical Arm running motor_ctrl --fixed-pi with PTHREAD_PRIO_INHERIT enabled. QNX 8.0 boosts calib_worker (15f -> 60f) for 48 us on mutex contention, blocking diag_streamer preemption and holding max jitter at 112.6 us.',
    meta: {
      name: 'Robotic Surgical Arm (PTHREAD_PRIO_INHERIT Verified)',
      target: 'x86_64-neutrino-8.0 (procnto-smp-instr)',
      mode: '--fixed-pi'
    },
    pidin: `PID   TID   PROCESS         PRIO  STATE     BLOCKED   THREAD_NAME
5204  3     motor_ctrl      60f   RUNNING   -         actuator_1khz
5201  1     sensor_broker   55f   RECEIVE   1         ipc_broker
5198  1     ethercat_drv    52f   RECEIVE   1         ecat_master
5204  2     motor_ctrl      35f   NANOSLEEP -         diag_streamer
5204  1     motor_ctrl      15f   NANOSLEEP -         calib_worker
5010  1     slogger2        21r   RECEIVE   1         slogger2_main
5012  1     pps             21r   RECEIVE   1         pps_server`,
    slog2: `Nov 19 11:22:10.005  sensor_broker.5201  1000  5  sensor_broker online pid=5201 chid=1 prio=55f cycles_per_sec=2400000000
Nov 19 11:22:10.030  motor_ctrl.5204     2000  5  motor_ctrl starting pid=5204 mode=--fixed-pi mutex_protocol=PTHREAD_PRIO_INHERIT
Nov 19 11:22:10.280  motor_ctrl.5204     2005  5  RT_TICK iter=25 jitter_us=74.1 brake_kpa=4210 pi=PRIO_INHERIT
Nov 19 11:22:10.530  motor_ctrl.5204     2005  5  RT_TICK iter=50 jitter_us=89.5 brake_kpa=4224 pi=PRIO_INHERIT
Nov 19 11:22:10.780  motor_ctrl.5204     2005  5  RT_TICK iter=75 jitter_us=112.6 brake_kpa=4238 pi=PRIO_INHERIT
Nov 19 11:22:11.030  motor_ctrl.5204     2005  5  RT_TICK iter=100 jitter_us=81.3 brake_kpa=4240 pi=PRIO_INHERIT
Nov 19 11:22:11.290  motor_ctrl.5204     2099  5  motor_ctrl summary mode=FIXED_PI max_jitter_us=112.6 violations=0/200`,
    trace: `time_us,cpu,class,event,pid,tid,prio,target_pid,target_tid,detail
0,0,THREAD,THRUNNING,5204,1,15,-,-,calib_worker acquires g_calib_mtx (PTHREAD_PRIO_INHERIT)
40,0,THREAD,THRUNNING,5204,3,60,-,-,actuator_1khz wakes on 1kHz monotonic timer
52,0,COMM,MSG_SENDV,5204,3,60,5201,1,MSG_TYPE_READ_SENSOR seq=75
58,1,THREAD,THRUNNING,5201,1,55,-,-,sensor_broker handles READ_SENSOR
75,1,COMM,MSG_REPLYV,5201,1,55,5204,3,SENSOR_VALID status=0x1
82,1,COMM,MSG_PULSE,5201,1,55,5012,1,PULSE_CODE_SENSOR_READY seq=75
85,0,THREAD,THRUNNING,5204,3,60,-,-,actuator_1khz calls pthread_mutex_lock(g_calib_mtx)
92,0,SYNC,THMUTEX,5204,3,60,5204,1,Contention on g_calib_mtx -> triggers QNX PI boost
94,0,THREAD,PI_BOOST,5204,1,60,-,-,QNX kernel boosts calib_worker prio 15f -> 60f
110,0,THREAD,THREADY,5204,2,35,-,-,diag_streamer ready but CANNOT preempt boosted prio 60f
142,0,SYNC,MUTEX_UNLOCK,5204,1,60,-,-,calib_worker unlocks g_calib_mtx and restores prio 15f
148,0,THREAD,THRUNNING,5204,3,60,-,-,actuator_1khz completes control frame jitter_us=112.6
180,0,THREAD,THNANOSLEEP,5204,3,60,-,-,actuator_1khz sleeps for next 1kHz tick
185,0,THREAD,THRUNNING,5204,2,35,-,-,diag_streamer runs safely in slack window
520,0,THREAD,THNANOSLEEP,5204,2,35,-,-,diag_streamer completes burst
530,1,THREAD,THRECEIVE,5201,1,55,-,-,sensor_broker waiting in MsgReceive()`,
    pps: `@telemetry
seq:n:75
brake_pressure_kpa:n:4238
imu_yaw_mdeg:n:14
temp_mC:n:38400
ipc_service_us:n:23.40
status:s:NOMINAL_RT

@actuator
mode:s:FIXED_PI
mutex_protocol:s:PTHREAD_PRIO_INHERIT
max_jitter_us:n:112.6
deadline_budget_us:n:500.0
inversion_detected:b:false
active_faults:json:[]`
  },

  'qemu-starter': {
    id: 'qemu-starter',
    label: 'QEMU x86_64 Starter Image',
    badge: 'IPC SPIKE',
    description:
      'Fresh QNX Neutrino 8.0 QEMU x86_64 IFS image (procnto-smp-instr) with sensor_broker, motor_ctrl, slogger2, and pps. Captures a 618.5 us synchronous REPLY stall caused by unbuffered slog2 flush inside sensor_broker.',
    meta: {
      name: 'QNX 8.0 QEMU x86_64 IFS Starter Capture',
      target: 'qemu-x86_64-neutrino-8.0 (qnx8-pulse-x86_64.ifs)',
      mode: 'qemu-default'
    },
    pidin: `PID   TID   PROCESS         PRIO  STATE     BLOCKED   THREAD_NAME
1024  3     motor_ctrl      60f   REPLY     1020:1    actuator_1khz
1020  1     sensor_broker   55f   SEND      1004:1    ipc_broker
1004  1     slogger2        21r   RUNNING   -         slogger2_main
1006  1     pps             21r   RECEIVE   1         pps_server
1024  2     motor_ctrl      35f   NANOSLEEP -         diag_streamer
1024  1     motor_ctrl      15f   NANOSLEEP -         calib_worker
1002  1     devc-ser8250    24r   RECEIVE   1         ser8250_isr`,
    slog2: `Nov 19 11:25:01.002  slogger2.1004       0001  5  QNX Neutrino 8.0.0 x86_64 SMP instrumented kernel booted in QEMU
Nov 19 11:25:01.115  sensor_broker.1020  1000  5  sensor_broker online pid=1020 chid=1 prio=55f cycles_per_sec=2000000000
Nov 19 11:25:01.210  motor_ctrl.1024     2000  5  motor_ctrl starting pid=1024 mode=--fixed-pi mutex_protocol=PTHREAD_PRIO_INHERIT
Nov 19 11:25:01.490  motor_ctrl.1024     2005  5  RT_TICK iter=25 jitter_us=142.0 brake_kpa=4205 pi=PRIO_INHERIT
Nov 19 11:25:01.760  sensor_broker.1020  1003  3  PPS write contention on /pps/qnx/telemetry delayed MsgReply
Nov 19 11:25:01.761  motor_ctrl.1024     2010  2  DEADLINE_VIOLATION iter=50 jitter_us=618.5 budget_us=500.0 pi=PRIO_INHERIT
Nov 19 11:25:02.020  motor_ctrl.1024     2005  5  RT_TICK iter=75 jitter_us=158.2 brake_kpa=4219 pi=PRIO_INHERIT`,
    trace: `time_us,cpu,class,event,pid,tid,prio,target_pid,target_tid,detail
0,0,THREAD,THRUNNING,1024,3,60,-,-,actuator_1khz wakes in QEMU x86_64
25,0,COMM,MSG_SENDV,1024,3,60,1020,1,MSG_TYPE_READ_SENSOR seq=50
32,1,THREAD,THRUNNING,1020,1,55,-,-,sensor_broker handles READ_SENSOR
95,1,COMM,MSG_SENDV,1020,1,55,1004,1,Synchronous slog2 buffer flush during hot path
105,1,THREAD,THRUNNING,1004,1,21,-,-,slogger2 flushing ring pages under load
545,1,COMM,MSG_REPLYV,1004,1,21,1020,1,slogger2 flush ack
575,1,COMM,MSG_REPLYV,1020,1,55,1024,3,SENSOR_VALID delayed reply
590,1,COMM,MSG_PULSE,1020,1,55,1006,1,PULSE_CODE_SENSOR_READY seq=50
600,0,THREAD,THRUNNING,1024,3,60,-,-,actuator_1khz resumes jitter_us=618.5
645,0,THREAD,THNANOSLEEP,1024,3,60,-,-,actuator_1khz sleeps for next 1kHz tick
660,1,THREAD,THRECEIVE,1020,1,55,-,-,sensor_broker idle in MsgReceive()`,
    pps: `@telemetry
seq:n:50
brake_pressure_kpa:n:4219
imu_yaw_mdeg:n:8
temp_mC:n:35800
ipc_service_us:n:543.00
status:s:DEGRADED_LATENCY

@qemu_env
image:s:qnx8-pulse-x86_64.ifs
kernel:s:procnto-smp-instr
vcpus:n:2
memory_mb:n:512`
  },

  'adas-multihop-pi': {
    id: 'adas-multihop-pi',
    label: 'ADAS Multi-Hop PI Chain (4-Core SMP)',
    badge: 'MULTI-HOP PI',
    description:
      '4-core SMP ADAS Sensor Fusion ECU reproducing a 3-hop transitive Priority Inheritance chain: fusion_ctrl (65f) blocks on g_fusion_mtx held by lidar_bridge (40f), which blocks on g_calib_mtx held by nvm_flusher (15f). Medium-priority can_logger (50f) and ota_hasher (28f) preempt across CPU0..CPU3 while unpinned threads migrate cores, driving worst-case blocking latency to 2,240.0 us.',
    meta: {
      name: 'ADAS 4-Core SMP Transitive Multi-Hop PI Chain',
      target: 'aarch64-neutrino-8.0 (procnto-smp-instr 4-core)',
      mode: '--inject-multihop-inversion'
    },
    pidin: `PID   TID   PROCESS         PRIO  STATE     BLOCKED                 THREAD_NAME
6201  4     adas_fusion     65f   MUTEX     6201:2(g_fusion_mtx)    fusion_ctrl
6201  5     adas_fusion     58f   MUTEX     6201:2(g_fusion_mtx)    lane_planner
6201  2     adas_fusion     40f   MUTEX     6201:1(g_calib_mtx)     lidar_bridge
6201  1     adas_fusion     15f   READY     -                       nvm_flusher
6205  1     can_telemetry   50f   RUNNING   -                       can_logger
6208  1     ota_service     28f   RUNNING   -                       ota_hasher
6202  1     radar_broker    55f   RECEIVE   1                       radar_ipc
6010  1     slogger2        21r   RECEIVE   1                       slogger2_main
6012  1     pps             21r   RECEIVE   1                       pps_server`,
    slog2: `Nov 19 11:30:00.008  radar_broker.6202   1000  5  radar_broker online pid=6202 chid=1 prio=55f cores=4 cycles_per_sec=2400000000
Nov 19 11:30:00.032  adas_fusion.6201    2000  5  adas_fusion starting pid=6201 smp_cores=4 mode=--inject-multihop-inversion mutex_protocol=PTHREAD_PRIO_NONE
Nov 19 11:30:00.140  adas_fusion.6201    2005  5  RT_TICK iter=10 jitter_us=88.2 fusion_ms=0.09 pi=PRIO_NONE
Nov 19 11:30:00.240  adas_fusion.6201    2005  5  RT_TICK iter=20 jitter_us=142.5 fusion_ms=0.14 pi=PRIO_NONE
Nov 19 11:30:00.340  adas_fusion.6201    2005  5  RT_TICK iter=30 jitter_us=268.4 fusion_ms=0.27 pi=PRIO_NONE
Nov 19 11:30:00.440  adas_fusion.6201    2005  5  RT_TICK iter=40 jitter_us=412.0 fusion_ms=0.41 pi=PRIO_NONE
Nov 19 11:30:00.540  adas_fusion.6201    2010  2  DEADLINE_VIOLATION iter=50 jitter_us=1185.6 budget_us=500.0 pi=PRIO_NONE
Nov 19 11:30:00.640  adas_fusion.6201    2010  2  DEADLINE_VIOLATION iter=60 jitter_us=2240.0 budget_us=500.0 pi=PRIO_NONE
Nov 19 11:30:00.740  adas_fusion.6201    2010  3  SMP_MIGRATION tid=4 moved CPU0->CPU2 without _NTO_TCTL_RUNMASK pinning
Nov 19 11:30:00.840  adas_fusion.6201    2099  2  adas_fusion summary mode=MULTIHOP_INVERSION max_jitter_us=2240.0 violations=2/60`,
    trace: `time_us,cpu,class,event,pid,tid,prio,target_pid,target_tid,detail
0,0,THREAD,THRUNNING,6201,1,15,-,-,nvm_flusher acquires g_calib_mtx (PTHREAD_PRIO_NONE) cs_us=80
30,1,THREAD,THRUNNING,6201,2,40,-,-,lidar_bridge acquires g_fusion_mtx cs_us=65
55,1,SYNC,THMUTEX,6201,2,40,6201,1,Blocked on g_calib_mtx held by nvm_flusher(6201:1)
70,0,THREAD,THRUNNING,6201,4,65,-,-,fusion_ctrl wakes on 1kHz monotonic timer on CPU0
85,0,COMM,MSG_SENDV,6201,4,65,6202,1,MSG_TYPE_RADAR_FRAME seq=60
92,3,THREAD,THRUNNING,6202,1,55,-,-,radar_ipc handles radar point cloud on CPU3
118,3,COMM,MSG_REPLYV,6202,1,55,6201,4,RADAR_VALID frames=64
125,3,COMM,MSG_PULSE,6202,1,55,6012,1,PULSE_CODE_RADAR_PPS seq=60
135,2,THREAD,THRUNNING,6201,4,65,-,-,fusion_ctrl migrated CPU0->CPU2 unpinned
150,2,SYNC,THMUTEX,6201,4,65,6201,2,Blocked on g_fusion_mtx held by lidar_bridge(6201:2)
162,2,THREAD,THRUNNING,6201,5,58,-,-,lane_planner wakes on CPU2
175,2,SYNC,THMUTEX,6201,5,58,6201,2,Blocked on g_fusion_mtx held by lidar_bridge(6201:2)
185,0,THREAD,THREADY,6201,1,15,-,-,nvm_flusher preempted on CPU0 while holding g_calib_mtx
190,0,THREAD,THRUNNING,6208,1,28,-,-,ota_hasher SHA-256 verification burst preempts prio 15
210,1,THREAD,THRUNNING,6205,1,50,-,-,can_logger burst runs on CPU1 preempting prio 40 tier
940,1,THREAD,THNANOSLEEP,6205,1,50,-,-,can_logger completes frame batch
1020,0,THREAD,THNANOSLEEP,6208,1,28,-,-,ota_hasher pauses chunked verify
1030,3,THREAD,THRUNNING,6208,1,28,-,-,ota_hasher migrated CPU0->CPU3 for second hash pass
1260,3,THREAD,THNANOSLEEP,6208,1,28,-,-,ota_hasher finishes hash pass
1270,0,THREAD,THRUNNING,6201,1,15,-,-,nvm_flusher resumes after 1085us starvation
1350,0,SYNC,MUTEX_UNLOCK,6201,1,15,-,-,nvm_flusher releases g_calib_mtx
1365,2,THREAD,THRUNNING,6201,2,40,-,-,lidar_bridge migrated CPU1->CPU2 and acquires g_calib_mtx
1430,2,SYNC,MUTEX_UNLOCK,6201,2,40,-,-,lidar_bridge releases g_fusion_mtx
1445,2,THREAD,THRUNNING,6201,4,65,-,-,fusion_ctrl unblocked jitter_us=2240.0
1520,2,THREAD,THNANOSLEEP,6201,4,65,-,-,fusion_ctrl sleeps for next 1kHz tick
1530,1,THREAD,THRUNNING,6201,5,58,-,-,lane_planner migrated CPU2->CPU1 and resumes
1595,1,THREAD,THNANOSLEEP,6201,5,58,-,-,lane_planner completes cycle jitter_us=1185.6
1610,3,THREAD,THRECEIVE,6202,1,55,-,-,radar_ipc idle in MsgReceive()`,
    pps: `@telemetry
seq:n:60
radar_targets:n:14
lidar_points:n:64200
ipc_service_us:n:26.00
smp_cores_active:n:4
status:s:DEGRADED_MULTIHOP_PI

@adas_ecu
mode:s:MULTIHOP_INVERSION
mutex_protocol:s:PTHREAD_PRIO_NONE
blocking_chain_hops:n:2
max_jitter_us:n:2240.0
deadline_budget_us:n:500.0
inversion_detected:b:true
active_faults:json:["TRANSITIVE_PI_CHAIN","PRIORITY_INVERSION","SMP_UNPINNED_MIGRATION","DEADLINE_EXCEEDED"]`
  }
};

export function getPreset(name) {
  return PRESETS[name] || null;
}

export function listPresetIds() {
  return Object.keys(PRESETS);
}
