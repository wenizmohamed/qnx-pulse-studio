cmake_minimum_required(VERSION 3.22)
project(qnx_pulse_target C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)

add_compile_options(-Wall -Wextra -O2)

add_executable(sensor_broker
    src/sensor_broker.c
)
target_include_directories(sensor_broker PRIVATE src)
target_link_libraries(sensor_broker PRIVATE slog2)

add_executable(motor_ctrl
    src/motor_ctrl.c
)
target_include_directories(motor_ctrl PRIVATE src)
target_link_libraries(motor_ctrl PRIVATE slog2)

install(TARGETS sensor_broker motor_ctrl RUNTIME DESTINATION bin)
