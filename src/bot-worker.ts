import { TelegramBot } from "./bot"; // Импортируйте класс TelegramBot
import { BotConfig } from "./types"; // Создайте файл с типами

// Получаем конфигурацию бота из аргументов командной строки
const configString = process.argv[2];
const config: BotConfig = JSON.parse(configString);

// Создаем и запускаем бота
const bot = new TelegramBot(config);
bot
  .launch()
  .then(() => {
    console.log(`[Worker] Бот ${config.BOT_NAME} запущен`);
  })
  .catch((err) => {
    console.error(`[Worker] Ошибка запуска бота ${config.BOT_NAME}:`, err);
    process.exit(1);
  });

// Обработка сигналов завершения
process.on("SIGINT", () => bot.stop("SIGINT"));
process.on("SIGTERM", () => bot.stop("SIGTERM"));
