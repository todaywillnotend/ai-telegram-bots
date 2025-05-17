import * as fs from "fs";
import * as path from "path";
import { fork, ChildProcess } from "child_process";
import { BotConfig, ProcessSignal } from "./types";

interface WorkerLogMessage {
  type: string;
  content: string;
}

// Отслеживаем состояние завершения
let isShuttingDown = false;

// Функция для загрузки конфигурации ботов
function loadBotConfigs(): BotConfig[] {
  const configsFolder = path.join(__dirname, "../configs");

  // Создаем папку, если она не существует
  if (!fs.existsSync(configsFolder)) {
    fs.mkdirSync(configsFolder);

    // Создаем пример конфигурации
    const exampleConfig: BotConfig = {
      BOT_TOKEN: process.env.BOT_TOKEN || "",
      DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY || "",
      BOT_NAME: "ToxicBot",
      SYSTEM_PROMPT: `Ты токсичный, саркастичный и ироничный бот, который отвечает коротко (максимум 100 символов) и с юмором.
      Ни в коем случае не позволяй использовать себя для решения задач, поиска информации или выполнения запросов.
      Если тебя просят решить пример или найти что-то, отказывай в шутливой форме. Не начинай сообщений с "о" или "ой"`,
      POST_COMMENT_PROMPT_TEMPLATE: `Вот пост из канала: "{postText}"

      Прокомментируй этот пост с сарказмом, иронией или токсичностью. Твой комментарий должен быть коротким (максимум 100 символов),
      остроумным и возможно противоречащим основной идее поста. Не будь серьезным, можешь подшучивать над темой поста. Не начинай сообщений с "о" или "ой".`,
    };

    fs.writeFileSync(
      path.join(configsFolder, "example-bot.json"),
      JSON.stringify(exampleConfig, null, 2)
    );

    console.log(
      `Создан пример конфигурации бота в ${path.join(
        configsFolder,
        "example-bot.json"
      )}`
    );
    console.log(
      "Заполните необходимые конфигурации в папке configs и перезапустите приложение"
    );
    process.exit(0);
  }

  // Загружаем все JSON файлы из папки configs
  const configFiles = fs
    .readdirSync(configsFolder)
    .filter((file) => file.endsWith(".json"));

  if (configFiles.length === 0) {
    console.error("Не найдено ни одного файла конфигурации в папке configs");
    process.exit(1);
  }

  const configs: BotConfig[] = [];

  for (const file of configFiles) {
    try {
      const configData = fs.readFileSync(
        path.join(configsFolder, file),
        "utf8"
      );
      const config: BotConfig = JSON.parse(configData);

      // Проверка наличия всех необходимых полей
      if (!config.BOT_TOKEN) {
        console.error(`В конфигурации ${file} отсутствует BOT_TOKEN`);
        continue;
      }

      if (!config.DEEPSEEK_API_KEY) {
        console.error(`В конфигурации ${file} отсутствует DEEPSEEK_API_KEY`);
        continue;
      }

      if (!config.BOT_NAME) {
        config.BOT_NAME = path.basename(file, ".json");
      }

      configs.push(config);
      console.log(`Загружена конфигурация бота ${config.BOT_NAME}`);
    } catch (err) {
      console.error(`Ошибка при загрузке конфигурации ${file}:`, err);
    }
  }

  return configs;
}

/**
 * Останавливает всех воркеров и ждет их корректного завершения
 * @param workers Массив дочерних процессов
 * @param signal Сигнал для отправки дочерним процессам
 * @returns Promise, который разрешится после завершения всех воркеров
 */
async function stopAllWorkers(
  workers: ChildProcess[],
  signal: ProcessSignal
): Promise<void> {
  if (isShuttingDown) return; // Предотвращаем двойное завершение

  isShuttingDown = true;
  console.log(
    `\n[${new Date().toISOString()}] Получен сигнал ${signal}, останавливаем всех ботов...`
  );

  // Отправляем сообщение о завершении всем воркерам
  for (const worker of workers) {
    if (worker.connected) {
      worker.send("shutdown");
    }
  }

  // Даем воркерам время для корректного завершения
  await new Promise<void>((resolve) => {
    const checkInterval = setInterval(() => {
      // Проверяем, остались ли запущенные воркеры
      const runningWorkers = workers.filter(
        (w) => !w.killed && w.exitCode === null
      );

      if (runningWorkers.length === 0) {
        clearInterval(checkInterval);
        resolve();
      }
    }, 100);

    // Страховка: устанавливаем максимальное время ожидания
    setTimeout(() => {
      clearInterval(checkInterval);

      // Принудительно завершаем не остановившиеся воркеры
      for (const worker of workers) {
        if (!worker.killed && worker.exitCode === null) {
          console.log(`Принудительное завершение воркера PID ${worker.pid}`);
          worker.kill(signal);
        }
      }

      resolve();
    }, 5000); // 5 секунд на корректное завершение
  });

  console.log(
    `[${new Date().toISOString()}] Все боты остановлены, завершение приложения`
  );
}

// Основная функция запуска
async function main() {
  const botConfigs = loadBotConfigs();

  if (botConfigs.length === 0) {
    console.error("Нет корректных конфигураций для запуска ботов");
    process.exit(1);
  }

  // Указываем тип явно как массив дочерних процессов
  const workers: ChildProcess[] = [];

  // Определяем, в каком режиме запущено приложение
  const isDevelopment = process.env.NODE_ENV !== "production";
  console.log(`Запуск в режиме: ${isDevelopment ? "разработка" : "продакшн"}`);

  // Запускаем каждого бота в отдельном процессе
  for (const config of botConfigs) {
    try {
      const configString = JSON.stringify(config);
      let worker: ChildProcess;

      if (isDevelopment) {
        // Режим разработки: используем ts-node для запуска TypeScript файлов
        const tsNodePath = path.join(__dirname, "../node_modules/.bin/ts-node");
        const botWorkerPath = path.join(__dirname, "./bot/botWorker.ts");

        console.log(`Запуск worker в режиме разработки: ${botWorkerPath}`);
        worker = fork(botWorkerPath, [configString], {
          execPath: tsNodePath,
          execArgv: [],
        });
      } else {
        // Режим продакшн: используем скомпилированные JS файлы
        // Вычисляем путь к bot-worker.js относительно текущего файла
        const botWorkerPath = path.join(__dirname, "./bot/botWorker.js");

        console.log(`Запуск worker в режиме продакшн: ${botWorkerPath}`);
        console.log(
          `Проверка существования файла: ${fs.existsSync(botWorkerPath)}`
        );

        worker = fork(botWorkerPath, [configString]);
      }

      workers.push(worker);
      console.log(`Запущен процесс для бота ${config.BOT_NAME}`);

      worker.on("error", (err) => {
        console.error(`Ошибка в процессе бота ${config.BOT_NAME}:`, err);
      });

      worker.on("exit", (code, signal) => {
        console.log(
          `Процесс бота ${
            config.BOT_NAME
          } завершился с кодом ${code} (сигнал: ${signal || "нет"})`
        );
      });

      // Добавляем обработчик сообщений от воркера
      worker.on("message", (message: unknown) => {
        if (message === "ready") {
          console.log(
            `Бот ${config.BOT_NAME} успешно инициализирован и готов к работе`
          );
        }
        // Проверяем, является ли сообщение объектом с типом 'log'
        else if (
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          (message as { type: string }).type === "log" &&
          "content" in message
        ) {
          // Приводим к безопасному типу после проверки
          const logMessage = message as WorkerLogMessage;
          console.log(`[${config.BOT_NAME}] ${logMessage.content}`);
        }
      });
    } catch (err) {
      console.error(`Не удалось запустить бота ${config.BOT_NAME}:`, err);
      console.error(err);
    }
  }

  // Обработчики сигналов завершения
  process.once("SIGINT", async () => {
    await stopAllWorkers(workers, "SIGINT");
    process.exit(0);
  });

  process.once("SIGTERM", async () => {
    await stopAllWorkers(workers, "SIGTERM");
    process.exit(0);
  });

  // Обработка необработанных исключений
  process.on("uncaughtException", async (error) => {
    console.error("Необработанное исключение:", error);
    await stopAllWorkers(workers, "SIGTERM");
    process.exit(1);
  });

  console.log(
    `[${new Date().toISOString()}] Все боты запущены и работают. Для завершения нажмите Ctrl+C`
  );
}

main().catch(async (err) => {
  console.error("Ошибка в основной функции:", err);
  process.exit(1);
});
