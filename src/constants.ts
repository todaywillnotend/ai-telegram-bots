export const BOT_DEFAULTS = {
  CONTEXT: {
    // Базовое время жизни контекста (30 минут)
    BASE_TTL_MS: 30 * 60 * 1000, // 30 минут
    // Расширенное время жизни для активных бесед (2 часа)
    ACTIVE_TTL_MS: 2 * 60 * 60 * 1000, // 2 часа
    CLEANUP_INTERVAL_MS: 5 * 60 * 1000, // 5 минут
  },
  HISTORY: {
    // История сообщений
    DEFAULT_LENGTH: 15,
    MAX_LENGTH: 30,
    // Количество сообщений для отправки в API
    RELEVANT_LENGTH: 10,
  },
  MESSAGES: {
    // Максимальная длина сообщения Telegram
    MAX_LENGTH: 4096,
    MAX_SAFE_LENGTH: 10000,
    // Количество сообщений, после которого повторяем настройку
    REMINDER_INTERVAL: 10,
  },
  API: {
    DEFAULT_RETRIES: 3,
    DEFAULT_TIMEOUT_MS: 30000,
    BACKOFF_BASE_MS: 1000,
  },
  POSTS: {
    // Вероятность комментирования поста (100%)
    COMMENT_PROBABILITY: 1.0, // 100%
    MIN_TEXT_LENGTH: 5,
  },
};
