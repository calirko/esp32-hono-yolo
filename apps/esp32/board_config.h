#ifndef BOARD_CONFIG_H
#define BOARD_CONFIG_H

//
// WARNING!!! PSRAM IC required for UXGA resolution and high JPEG quality
//            Ensure ESP32 Wrover Module or other board with PSRAM is selected
//            Partial images will be transmitted if image exceeds buffer size
//
//            You must select partition scheme from the board menu that has at least 3MB APP space.

#define CAMERA_MODEL_WROVER_KIT // Has PSRAM
#include "camera_pins.h"

#define LED_GPIO_NUM 2

#endif  // BOARD_CONFIG_H
