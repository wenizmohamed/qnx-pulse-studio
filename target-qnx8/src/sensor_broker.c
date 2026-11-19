/*
 * QNX Pulse Studio - QNX Neutrino 8.0 Sensor Broker Service
 *
 * Demonstrates authentic QNX 8.0 microkernel primitives:
 *   - name_attach() global GNS/pathname channel registration
 *   - MsgReceive() / MsgReply() zero-copy synchronous IPC server loop
 *   - MsgSendPulse() asynchronous notification to high-priority consumers
 *   - ClockCycles() + SYSPAGE_ENTRY(qtime)->cycles_per_sec deterministic timing
 *   - SCHED_FIFO real-time thread priority assignment
 *   - slog2f() structured kernel/service telemetry logging
 *   - /pps/qnx/telemetry Persistent Publish/Subscribe (PPS) object updates
 *
 * Build: qcc -Vgcc_ntox86_64 -O2 -Wall -Wextra -o sensor_broker sensor_broker.c -lslog2
 * SPDX-License-Identifier: MIT
 */

#define _QNX_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <sched.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/dispatch.h>
#include <sys/neutrino.h>
#include <sys/slog2.h>
#include <sys/syspage.h>
#include <unistd.h>

#include "common_ipc.h"

static volatile sig_atomic_t g_running = 1;
static slog2_buffer_t        g_slog_buf = NULL;

static void handle_signal(int signo) {
    (void)signo;
    g_running = 0;
}

static int init_slog2(void) {
    slog2_buffer_set_config_t cfg;
    memset(&cfg, 0, sizeof(cfg));
    cfg.buffer_set_name       = "sensor_broker";
    cfg.num_buffers           = 1;
    cfg.verbosity_level       = SLOG2_INFO;
    cfg.buffer_config[0].buffer_name = "ipc_broker";
    cfg.buffer_config[0].num_pages   = 8;

    return slog2_register(&cfg, &g_slog_buf, 0);
}

static int configure_fifo_priority(int prio) {
    struct sched_param sp;
    memset(&sp, 0, sizeof(sp));
    sp.sched_priority = prio;
    return pthread_setschedparam(pthread_self(), SCHED_FIFO, &sp);
}

static void publish_pps_telemetry(int pps_fd, uint32_t seq, const sensor_reply_t *rep, double ipc_us) {
    if (pps_fd < 0) {
        return;
    }
    char payload[512];
    int n = snprintf(
        payload,
        sizeof(payload),
        "@telemetry\n"
        "seq:n:%u\n"
        "brake_pressure_kpa:n:%d\n"
        "imu_yaw_mdeg:n:%d\n"
        "temp_mC:n:%d\n"
        "ipc_service_us:n:%.2f\n"
        "status:s:%s\n",
        seq,
        rep->brake_pressure_kpa,
        rep->imu_yaw_mdeg,
        rep->temp_mC,
        ipc_us,
        (ipc_us > 500.0) ? "DEGRADED_LATENCY" : "NOMINAL_RT"
    );
    if (n > 0) {
        (void)write(pps_fd, payload, (size_t)n);
    }
}

int main(int argc, char *argv[]) {
    int server_prio = 55;
    int notify_coid = -1;

    for (int i = 1; i < argc; ++i) {
        if (strcmp(argv[i], "--prio") == 0 && i + 1 < argc) {
            server_prio = atoi(argv[++i]);
        }
    }

    signal(SIGINT, handle_signal);
    signal(SIGTERM, handle_signal);

    if (init_slog2() == -1) {
        fprintf(stderr, "sensor_broker: slog2_register failed (%s)\n", strerror(errno));
    }

    if (configure_fifo_priority(server_prio) != 0) {
        slog2f(g_slog_buf, 1001, SLOG2_WARNING,
               "Failed to set SCHED_FIFO prio %d (%s); continuing with inherited prio",
               server_prio, strerror(errno));
    }

    name_attach_t *attach = name_attach(NULL, SENSOR_BROKER_ATTACH_NAME, NAME_FLAG_ATTACH_GLOBAL);
    if (attach == NULL) {
        /* Fallback to local namespace if gns is not running in minimal QEMU IFS */
        attach = name_attach(NULL, SENSOR_BROKER_ATTACH_NAME, 0);
    }
    if (attach == NULL) {
        slog2f(g_slog_buf, 1002, SLOG2_CRITICAL,
               "name_attach(%s) failed: %s", SENSOR_BROKER_ATTACH_NAME, strerror(errno));
        return EXIT_FAILURE;
    }

    int pps_fd = open(PPS_TELEMETRY_PATH, O_WRONLY | O_CREAT | O_NONBLOCK, 0664);
    if (pps_fd < 0) {
        slog2f(g_slog_buf, 1003, SLOG2_WARNING,
               "PPS object %s unavailable (%s); telemetry PPS updates disabled",
               PPS_TELEMETRY_PATH, strerror(errno));
    }

    /* Self-connection for asynchronous pulse dispatch demonstrations */
    notify_coid = ConnectAttach(0, 0, attach->chid, _NTO_SIDE_CHANNEL, 0);

    slog2f(g_slog_buf, 1000, SLOG2_INFO,
           "sensor_broker online pid=%d chid=%d prio=%df cycles_per_sec=%llu",
           getpid(), attach->chid, server_prio,
           (unsigned long long)SYSPAGE_ENTRY(qtime)->cycles_per_sec);

    sensor_req_t   msg;
    sensor_reply_t rep;
    struct _msg_info info;
    uint32_t served_count = 0;

    while (g_running) {
        rcvid_t rcvid = MsgReceive(attach->chid, &msg, sizeof(msg), &info);
        if (rcvid == -1) {
            if (errno == EINTR) {
                continue;
            }
            slog2f(g_slog_buf, 1004, SLOG2_ERROR, "MsgReceive error: %s", strerror(errno));
            break;
        }

        uint64_t t0 = ClockCycles();

        if (rcvid == 0) {
            /* Kernel or client pulse received */
            if (msg.hdr.code == _PULSE_CODE_DISCONNECT) {
                ConnectDetach(msg.hdr.scoid);
            } else if (msg.hdr.code == PULSE_CODE_SENSOR_READY) {
                slog2f(g_slog_buf, 1005, SLOG2_DEBUG1,
                       "Pulse SENSOR_READY seq=%d", msg.hdr.value.sival_int);
            }
            continue;
        }

        if (msg.hdr.type == _IO_CONNECT) {
            MsgReply(rcvid, EOK, NULL, 0);
            continue;
        }

        if (msg.hdr.type == MSG_TYPE_READ_SENSOR) {
            served_count++;
            memset(&rep, 0, sizeof(rep));
            rep.seq                = msg.seq;
            rep.brake_pressure_kpa = 4200 + (int32_t)((msg.seq * 17U) % 240U);
            rep.imu_yaw_mdeg       = -125 + (int32_t)((msg.seq * 13U) % 250U);
            rep.temp_mC            = 41200 + (int32_t)(served_count % 300U);
            rep.broker_cycles      = ClockCycles();
            rep.status_flags       = 0x00000001U; /* SENSOR_VALID */

            double ipc_us = cycles_to_us(rep.broker_cycles - t0);
            if (MsgReply(rcvid, EOK, &rep, sizeof(rep)) == -1) {
                slog2f(g_slog_buf, 1006, SLOG2_ERROR,
                       "MsgReply failed for pid=%d tid=%d: %s",
                       info.pid, info.tid, strerror(errno));
            }

            if ((served_count % 10U) == 0U) {
                publish_pps_telemetry(pps_fd, rep.seq, &rep, ipc_us);
                if (notify_coid >= 0) {
                    (void)MsgSendPulse(notify_coid, server_prio, PULSE_CODE_SENSOR_READY, (int)rep.seq);
                }
            }
        } else {
            MsgError(rcvid, ENOSYS);
        }
    }

    if (notify_coid >= 0) {
        ConnectDetach(notify_coid);
    }
    if (pps_fd >= 0) {
        close(pps_fd);
    }
    name_detach(attach, 0);
    slog2f(g_slog_buf, 1009, SLOG2_INFO, "sensor_broker shutdown cleanly after %u frames", served_count);
    return EXIT_SUCCESS;
}
