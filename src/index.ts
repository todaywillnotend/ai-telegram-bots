import * as fs from "fs";
import * as path from "path";
import { fork, ChildProcess } from "child_process";
import { BotConfig, ProcessSignal } from "./types";

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

      worker.on("exit", (code) => {
        console.log(
          `Процесс бота ${config.BOT_NAME} завершился с кодом ${code}`
        );
      });
    } catch (err) {
      console.error(`Не удалось запустить бота ${config.BOT_NAME}:`, err);
      console.error(err);
    }
  }

  // Исправляем тип сигнала
  const stopWorkers = (signal: ProcessSignal) => {
    console.log(`Получен сигнал ${signal}, останавливаем всех ботов...`);
    for (const worker of workers) {
      worker.kill(signal);
    }
    process.exit(0);
  };

  process.once("SIGINT", () => stopWorkers("SIGINT"));
  process.once("SIGTERM", () => stopWorkers("SIGTERM"));
}

main().catch((err) => {
  console.error("Ошибка в основной функции:", err);
  process.exit(1);
});
