#include "Arduino.h"
#include "esp_http_server.h"
#include "esp_camera.h"
#include "img_converters.h"
#include "board_config.h"

#if defined(ARDUINO_ARCH_ESP32) && defined(CONFIG_ARDUHAL_ESP_LOG)
#include "esp32-hal-log.h"
#endif

#define API_KEY "0MYIWaLu8xM4KlL8RE7lgWvA17yMUN3M"

httpd_handle_t camera_httpd = NULL;

typedef struct {
  httpd_req_t *req;
  size_t len;
} jpg_chunking_t;

static bool check_api_key(httpd_req_t *req) {
  size_t key_len = httpd_req_get_hdr_value_len(req, "X-API-Key");
  if (key_len == 0) return false;

  char key[256];
  if (key_len >= sizeof(key)) return false;
  if (httpd_req_get_hdr_value_str(req, "X-API-Key", key, sizeof(key)) != ESP_OK) return false;

  return strcmp(key, API_KEY) == 0;
}

static size_t jpg_encode_stream(void *arg, size_t index, const void *data, size_t len) {
  jpg_chunking_t *j = (jpg_chunking_t *)arg;
  if (!index) {
    j->len = 0;
  }
  if (httpd_resp_send_chunk(j->req, (const char *)data, len) != ESP_OK) {
    return 0;
  }
  j->len += len;
  return len;
}

static void blink_request_led() {
  digitalWrite(LED_GPIO_NUM, HIGH);
  vTaskDelay(50 / portTICK_PERIOD_MS);
  digitalWrite(LED_GPIO_NUM, LOW);
}

static esp_err_t health_handler(httpd_req_t *req) {
  if (!check_api_key(req)) {
    httpd_resp_send_err(req, HTTPD_401_UNAUTHORIZED, "Unauthorized");
    return ESP_FAIL;
  }
  blink_request_led();
  httpd_resp_set_type(req, "application/json");
  return httpd_resp_sendstr(req, "{\"status\":\"ok\"}");
}

static esp_err_t capture_handler(httpd_req_t *req) {
  if (!check_api_key(req)) {
    httpd_resp_send_err(req, HTTPD_401_UNAUTHORIZED, "Unauthorized");
    return ESP_FAIL;
  }

  blink_request_led();
  int64_t t0 = esp_timer_get_time();
  log_i("[capture] request received");

  camera_fb_t *fb = esp_camera_fb_get();
  if (!fb) {
    log_e("[capture] camera capture failed");
    httpd_resp_send_500(req);
    return ESP_FAIL;
  }

  int64_t t1 = esp_timer_get_time();
  log_i("[capture] frame grabbed: %uB in %dms", fb->len, (int)((t1 - t0) / 1000));

  httpd_resp_set_type(req, "image/jpeg");
  httpd_resp_set_hdr(req, "Content-Disposition", "inline; filename=capture.jpg");

  log_i("[capture] sending image...");
  esp_err_t res;
  if (fb->format == PIXFORMAT_JPEG) {
    res = httpd_resp_send(req, (const char *)fb->buf, fb->len);
  } else {
    jpg_chunking_t jchunk = {req, 0};
    res = frame2jpg_cb(fb, 80, jpg_encode_stream, &jchunk) ? ESP_OK : ESP_FAIL;
    httpd_resp_send_chunk(req, NULL, 0);
  }
  esp_camera_fb_return(fb);

  int64_t t2 = esp_timer_get_time();
  log_i("[capture] done: sent in %dms, total %dms", (int)((t2 - t1) / 1000), (int)((t2 - t0) / 1000));

  return res;
}

void startCameraServer() {
  httpd_config_t config = HTTPD_DEFAULT_CONFIG();

  httpd_uri_t health_uri = {
    .uri = "/health",
    .method = HTTP_GET,
    .handler = health_handler,
    .user_ctx = NULL
  };

  httpd_uri_t capture_uri = {
    .uri = "/capture",
    .method = HTTP_GET,
    .handler = capture_handler,
    .user_ctx = NULL
  };

  log_i("Starting web server on port: '%u'", config.server_port);
  if (httpd_start(&camera_httpd, &config) == ESP_OK) {
    httpd_register_uri_handler(camera_httpd, &health_uri);
    httpd_register_uri_handler(camera_httpd, &capture_uri);
  }
}
