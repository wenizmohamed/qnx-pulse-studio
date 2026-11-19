# QNX Pulse Studio - QNX Neutrino 8.0 Target Makefile
# Requires QNX SDP 8.0 environment sourced (qnxsdp-env.sh / qnxsdp-env.bat)

CC      ?= qcc
VARIANT ?= gcc_ntox86_64
CFLAGS  := -V$(VARIANT) -std=c11 -O2 -Wall -Wextra -Isrc
LDFLAGS := -lslog2

BUILD_DIR := build
IFS_IMAGE := $(BUILD_DIR)/qnx8-pulse-x86_64.ifs

TARGETS := $(BUILD_DIR)/sensor_broker $(BUILD_DIR)/motor_ctrl

.PHONY: all clean ifs qemu

all: $(TARGETS)

$(BUILD_DIR):
	mkdir -p $(BUILD_DIR)

$(BUILD_DIR)/sensor_broker: src/sensor_broker.c src/common_ipc.h | $(BUILD_DIR)
	$(CC) $(CFLAGS) -o $@ src/sensor_broker.c $(LDFLAGS)

$(BUILD_DIR)/motor_ctrl: src/motor_ctrl.c src/common_ipc.h | $(BUILD_DIR)
	$(CC) $(CFLAGS) -o $@ src/motor_ctrl.c $(LDFLAGS)

ifs: all
	mkifs -v qnx8-qemu-x86_64.build $(IFS_IMAGE)
	@echo "[QNX Pulse] Bootable QNX 8.0 IFS built: $(IFS_IMAGE)"

qemu: ifs
	sh scripts/run-qemu.sh $(IFS_IMAGE)

clean:
	rm -rf $(BUILD_DIR)
