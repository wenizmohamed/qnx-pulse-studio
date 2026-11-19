# QNX SDP 8.0 Cross-Compilation Toolchain for x86_64 QEMU / Hardware Targets
# Usage:
#   cmake -B build -DCMAKE_TOOLCHAIN_FILE=qnx8-toolchain.cmake
#   cmake --build build

set(CMAKE_SYSTEM_NAME QNX)
set(CMAKE_SYSTEM_VERSION 8.0.0)
set(CMAKE_SYSTEM_PROCESSOR x86_64)

if(NOT DEFINED ENV{QNX_HOST} OR NOT DEFINED ENV{QNX_TARGET})
    message(FATAL_ERROR "QNX_HOST and QNX_TARGET must be set. Source qnxsdp-env.sh or qnxsdp-env.bat first.")
endif()

set(QNX_HOST   "$ENV{QNX_HOST}")
set(QNX_TARGET "$ENV{QNX_TARGET}")

set(QNX_ARCH_VARIANT "gcc_ntox86_64")

if(WIN32)
    set(HOST_EXE_SUFFIX ".exe")
else()
    set(HOST_EXE_SUFFIX "")
endif()

set(CMAKE_C_COMPILER   "${QNX_HOST}/usr/bin/qcc${HOST_EXE_SUFFIX}")
set(CMAKE_CXX_COMPILER "${QNX_HOST}/usr/bin/q++${HOST_EXE_SUFFIX}")
set(CMAKE_AR           "${QNX_HOST}/usr/bin/ntox86_64-ar${HOST_EXE_SUFFIX}" CACHE FILEPATH "Archiver")
set(CMAKE_RANLIB       "${QNX_HOST}/usr/bin/ntox86_64-ranlib${HOST_EXE_SUFFIX}" CACHE FILEPATH "Ranlib")

set(CMAKE_C_FLAGS_INIT   "-V${QNX_ARCH_VARIANT}")
set(CMAKE_CXX_FLAGS_INIT "-V${QNX_ARCH_VARIANT}")

set(CMAKE_FIND_ROOT_PATH "${QNX_TARGET}")
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
