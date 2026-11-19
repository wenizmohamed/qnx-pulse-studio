/*
 * QNX Pulse Studio - Shared QNX Neutrino 8.0 IPC Protocol Header
 * SPDX-License-Identifier: MIT
 */

#ifndef QNX_PULSE_COMMON_IPC_H
#define QNX_PULSE_COMMON_IPC_H

#include <stdint.h>
#include <sys/iomsg.h>
#include <sys/neutrino.h>
#include <sys/syspage.h>

#define SENSOR_BROKER_ATTACH_NAME "qnx/pulse/sensor_broker"
#define PPS_TELEMETRY_PATH        "/pps/qnx/telemetry"

/* Custom QNX message types (_IO_MAX + offset) */
#define MSG_TYPE_READ_SENSOR      (_IO_MAX + 0x10)
#define MSG_TYPE_PUBLISH_STATE    (_IO_MAX + 0x11)

/* Custom QNX pulse codes (_PULSE_CODE_MINAVAIL.._PULSE_CODE_MAXAVAIL) */
#define PULSE_CODE_CONTROL_TICK   (_PULSE_CODE_MINAVAIL + 1)
#define PULSE_CODE_SENSOR_READY   (_PULSE_CODE_MINAVAIL + 2)
#define PULSE_CODE_WATCHDOG_FAULT (_PULSE_CODE_MINAVAIL + 3)

typedef struct {
    struct _pulse hdr;
    uint32_t      seq;
    int32_t       torque_mNm;
    int32_t       wheel_rpm;
    uint64_t      tx_cycles;
} sensor_req_t;

typedef struct {
    uint32_t seq;
    int32_t  brake_pressure_kpa;
    int32_t  imu_yaw_mdeg;
    int32_t  temp_mC;
    uint64_t broker_cycles;
    uint32_t status_flags;
} sensor_reply_t;

static inline double cycles_to_us(uint64_t delta_cycles) {
    const uint64_t cps = SYSPAGE_ENTRY(qtime)->cycles_per_sec;
    return ((double)delta_cycles * 1000000.0) / (double)cps;
}

#endif /* QNX_PULSE_COMMON_IPC_H */
