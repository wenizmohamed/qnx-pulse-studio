/*
 * QNX Pulse Studio - QNX Neutrino 8.0 1kHz Hard-RT Motor Control Loop
 *
 * Reproduces AND fixes a textbook Real-Time Priority Inversion on QNX 8.0:
 *   - High-priority actuator thread  (SCHED_FIFO prio 60): 1kHz (1000us) hard-RT control loop
 *   - Medium-priority diag streamer  (SCHED_FIFO prio 35): bursty CPU-bound telemetry compression
 *   - Low-priority calibration task  (SCHED_FIFO prio 15): acquires shared calibration mutex
 *
 * Modes:
 *   --inject-inversion  Uses PTHREAD_PRIO_NONE mutex -> prio 35 preempts prio 15 while prio 60
 *                       blocks on mutex, spiking control jitter > 1,500 us (>500 us budget!).
 *   --fixed-pi          Uses PTHREAD_PRIO_INHERIT mutex -> QNX kernel boosts prio 15 -> 60
 *                       immediately on contention, keeping jitter < 150 us.
 *
 * Build: qcc -Vgcc_ntox86_64 -O2 -Wall -Wextra -o motor_ctrl motor_ctrl.c -lslog2
 * SPDX-License-Identifier: MIT
 */

#define _QNX_SOURCE
#include <errno.h>
#include <pthread.h>
#include <sched.h>
#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/dispatch.h>
#include <sys/neutrino.h>
#include <sys/slog2.h>
#include <sys/syspage.h>
#include <time.h>
#include <unistd.h>

#include "common_ipc.h"

#define CONTROL_PERIOD_NS      1000000L   /* 1 kHz = 1,000 us */
#define DEADLINE_JITTER_US     500.0
#define PRIO_HIGH_ACTUATOR     60
#define PRIO_MED_DIAG_STREAM   35
#define PRIO_LOW_CALIBRATION   15

typedef struct {
    double gain_kp;
    double gain_ki;
    uint32_t revision;
} calib_table_t;

static volatile sig_atomic_t g_running = 1;
static pthread_mutex_t       g_calib_mtx;
static calib_table_t         g_calib = { 1.42, 0.08, 1 };
static slog2_buffer_t        g_slog_buf = NULL;
static bool                  g_use_pi = false;
static int                   g_iterations = 200;

static void handle_signal(int signo) {
    (void)signo;
    g_running = 0;
}

static void busy_spin_us(uint64_t target_us) {
    uint64_t start = ClockCycles();
    uint64_t cps   = SYSPAGE_ENTRY(qtime)->cycles_per_sec;
    uint64_t ticks = (target_us * cps) / 1000000ULL;
    while ((ClockCycles() - start) < ticks) {
        __asm__ volatile("pause" ::: "memory");
    }
}

static int set_thread_fifo(int prio, const char *name) {
    struct sched_param sp;
    memset(&sp, 0, sizeof(sp));
    sp.sched_priority = prio;
    pthread_setname_np(pthread_self(), name);
    return pthread_setschedparam(pthread_self(), SCHED_FIFO, &sp);
}

/* Low-priority thread (prio 15): holds calibration mutex during brief table update */
static void *calib_worker_thread(void *arg) {
    (void)arg;
    set_thread_fifo(PRIO_LOW_CALIBRATION, "calib_worker");

    while (g_running) {
        pthread_mutex_lock(&g_calib_mtx);
        /* Critical section: ~90us calibration math */
        busy_spin_us(90);
        g_calib.revision++;
        g_calib.gain_kp = 1.40 + (double)(g_calib.revision % 5U) * 0.01;
        pthread_mutex_unlock(&g_calib_mtx);

        struct timespec nap = { 0, 2000000L }; /* 2 ms */
        nanosleep(&nap, NULL);
    }
    return NULL;
}

/* Medium-priority thread (prio 35): bursty CPU work that causes inversion if PI is disabled */
static void *diag_streamer_thread(void *arg) {
    (void)arg;
    set_thread_fifo(PRIO_MED_DIAG_STREAM, "diag_streamer");

    while (g_running) {
        /* 1.4 ms CPU-bound compression burst */
        busy_spin_us(1400);
        struct timespec nap = { 0, 3000000L }; /* 3 ms */
        nanosleep(&nap, NULL);
    }
    return NULL;
}

/* High-priority thread (prio 60): 1kHz hard-RT motor/brake control loop */
static void *actuator_loop_thread(void *arg) {
    (void)arg;
    set_thread_fifo(PRIO_HIGH_ACTUATOR, "actuator_1khz");

    int broker_coid = name_open(SENSOR_BROKER_ATTACH_NAME, 0);
    if (broker_coid < 0) {
        slog2f(g_slog_buf, 2001, SLOG2_WARNING,
               "sensor_broker not attached (%s); running local sensor fallback", strerror(errno));
    }

    struct timespec next_tick;
    clock_gettime(CLOCK_MONOTONIC, &next_tick);

    double max_jitter_us = 0.0;
    int    violations    = 0;

    for (int iter = 0; iter < g_iterations && g_running; ++iter) {
        next_tick.tv_nsec += CONTROL_PERIOD_NS;
        if (next_tick.tv_nsec >= 1000000000L) {
            next_tick.tv_sec += 1;
            next_tick.tv_nsec -= 1000000000L;
        }
        clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, &next_tick, NULL);

        uint64_t t_wake = ClockCycles();

        /* Step 1: Query sensor_broker over synchronous QNX IPC if connected */
        sensor_reply_t rep = { .brake_pressure_kpa = 4200, .imu_yaw_mdeg = 0 };
        if (broker_coid >= 0) {
            sensor_req_t req;
            memset(&req, 0, sizeof(req));
            req.hdr.type  = MSG_TYPE_READ_SENSOR;
            req.seq       = (uint32_t)iter;
            req.tx_cycles = t_wake;
            (void)MsgSend(broker_coid, &req, sizeof(req), &rep, sizeof(rep));
        }

        /* Step 2: Acquire shared calibration mutex (inversion point if PTHREAD_PRIO_NONE) */
        pthread_mutex_lock(&g_calib_mtx);
        double cmd_torque = (double)rep.brake_pressure_kpa * g_calib.gain_kp * 0.001;
        (void)cmd_torque;
        pthread_mutex_unlock(&g_calib_mtx);

        uint64_t t_done = ClockCycles();
        double   exec_us = cycles_to_us(t_done - t_wake);

        if (exec_us > max_jitter_us) {
            max_jitter_us = exec_us;
        }
        if (exec_us > DEADLINE_JITTER_US) {
            violations++;
            slog2f(g_slog_buf, 2010, SLOG2_ERROR,
                   "DEADLINE_VIOLATION iter=%d jitter_us=%.1f budget_us=%.1f pi=%s",
                   iter, exec_us, DEADLINE_JITTER_US, g_use_pi ? "PRIO_INHERIT" : "PRIO_NONE");
        } else if ((iter % 25) == 0) {
            slog2f(g_slog_buf, 2005, SLOG2_INFO,
                   "RT_TICK iter=%d jitter_us=%.1f brake_kpa=%d pi=%s",
                   iter, exec_us, rep.brake_pressure_kpa, g_use_pi ? "PRIO_INHERIT" : "PRIO_NONE");
        }
    }

    if (broker_coid >= 0) {
        name_close(broker_coid);
    }

    slog2f(g_slog_buf, 2099, violations > 0 ? SLOG2_ERROR : SLOG2_INFO,
           "motor_ctrl summary mode=%s max_jitter_us=%.1f violations=%d/%d",
           g_use_pi ? "FIXED_PI" : "INJECT_INVERSION", max_jitter_us, violations, g_iterations);
    g_running = 0;
    return NULL;
}

int main(int argc, char *argv[]) {
    for (int i = 1; i < argc; ++i) {
        if (strcmp(argv[i], "--fixed-pi") == 0) {
            g_use_pi = true;
        } else if (strcmp(argv[i], "--inject-inversion") == 0) {
            g_use_pi = false;
        } else if (strcmp(argv[i], "--iterations") == 0 && i + 1 < argc) {
            g_iterations = atoi(argv[++i]);
        }
    }

    signal(SIGINT, handle_signal);
    signal(SIGTERM, handle_signal);

    slog2_buffer_set_config_t cfg;
    memset(&cfg, 0, sizeof(cfg));
    cfg.buffer_set_name              = "motor_ctrl";
    cfg.num_buffers                  = 1;
    cfg.verbosity_level              = SLOG2_INFO;
    cfg.buffer_config[0].buffer_name = "rt_loop";
    cfg.buffer_config[0].num_pages   = 8;
    (void)slog2_register(&cfg, &g_slog_buf, 0);

    /* Configure mutex protocol: PTHREAD_PRIO_INHERIT fixes priority inversion */
    pthread_mutexattr_t mattr;
    pthread_mutexattr_init(&mattr);
    pthread_mutexattr_setprotocol(&mattr, g_use_pi ? PTHREAD_PRIO_INHERIT : PTHREAD_PRIO_NONE);
    pthread_mutex_init(&g_calib_mtx, &mattr);
    pthread_mutexattr_destroy(&mattr);

    slog2f(g_slog_buf, 2000, SLOG2_INFO,
           "motor_ctrl starting pid=%d mode=%s mutex_protocol=%s",
           getpid(),
           g_use_pi ? "--fixed-pi" : "--inject-inversion",
           g_use_pi ? "PTHREAD_PRIO_INHERIT" : "PTHREAD_PRIO_NONE");

    pthread_t th_low, th_med, th_high;
    pthread_create(&th_low, NULL, calib_worker_thread, NULL);
    pthread_create(&th_med, NULL, diag_streamer_thread, NULL);
    pthread_create(&th_high, NULL, actuator_loop_thread, NULL);

    pthread_join(th_high, NULL);
    pthread_join(th_med, NULL);
    pthread_join(th_low, NULL);

    pthread_mutex_destroy(&g_calib_mtx);
    return EXIT_SUCCESS;
}
