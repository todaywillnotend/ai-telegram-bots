import { Telegraf, Context } from "telegraf";
import * as dotenv from "dotenv";
import { BOT_DEFAULTS } from "../constants";
import { BotConfig } from "../types";
import { MessageHandlers } from "../messages/messageHandlers";
import { MessageSender } from "../messages/messageSender";
import { MessageParser } from "../messages/messageParser";
import { ApiService } from "../api/apiService";
import { ContextManager } from "../context/contextManager";

dotenv.config();

export class TelegramBot {
  private bot: Telegraf;
  private config: BotConfig;
  private botInfo: any;
  private startupTime: number;

  // Зависимости
  private apiService: ApiService;
  private contextManager: ContextManager;
  private messageParser: MessageParser;
  private messageSender: MessageSender;
  private messageHandlers: MessageHandlers;

  constructor(config: BotConfig) {
    this.config = config;
    this.bot = new Telegraf(this.config.BOT_TOKEN);
    this.startupTime = Date.now();

    // Создаем заглушку для информации о боте
    this.botInfo = { id: 0, username: "unknown" };

    // Инициализация зависимостей
    this.apiService = new ApiService(
      this.config.DEEPSEEK_API_KEY,
      this.config.BOT_NAME
    );
    this.contextManager = new ContextManager(this.config.BOT_NAME);
    this.messageParser = new MessageParser();
    this.messageSender = new MessageSender(this.config.BOT_NAME);

    // Создаем обработчики сообщений сразу
    this.messageHandlers = new MessageHandlers(
      this.config,
      this.apiService,
      this.contextManager,
      this.messageParser,
      this.messageSender,
      this.botInfo, // Пока с пустыми данными
      this.startupTime
    );

    // Глобальный обработчик ошибок
    this.setupErrorHandler();
  }

  /**
   * Настраивает глобальный обработчик ошибок
   * @private
   */
  private setupErrorHandler(): void {
    this.bot.catch((err, ctx) => {
      console.error(`[${this.config.BOT_NAME}] Unhandled error:`, err);
      // Не пытаемся ответить, так как это может вызвать новую ошибку
    });
  }

  /**
   * Инициализирует информацию о боте и настраивает обработчики сообщений
   * @private
   */
  private async initialize(): Promise<void> {
    try {
      // Получаем информацию о боте
      this.botInfo = await this.bot.telegram.getMe();
      console.log(
        `[${this.config.BOT_NAME}] Бот @${this.botInfo.username} готов к работе`
      );

      // Обновляем информацию о боте в обработчиках сообщений
      this.messageHandlers.updateBotInfo(this.botInfo);

      // Настраиваем обработчики сообщений
      this.setupMessageHandlers();
    } catch (error) {
      console.error(`[${this.config.BOT_NAME}] Error initializing bot:`, error);
      throw error;
    }
  }

  /**
   * Настраивает обработчики сообщений
   * @private
   */
  private setupMessageHandlers(): void {
    this.bot.on("message", async (ctx) => {
      await this.handleIncomingMessage(ctx);
    });
  }

  /**
   * Обрабатывает входящее сообщение
   * @param ctx Контекст Telegraf
   * @private
   */
  private async handleIncomingMessage(ctx: Context): Promise<void> {
    try {
      const message = ctx.message;
      if (!message) return;

      // Получаем текст сообщения или подпись к медиа
      const messageText = this.messageParser.getMessageText(message);

      // Пропускаем если нет текста или подписи
      if (!messageText) return;

      // Получаем время сообщения (в секундах, преобразуем в миллисекунды)
      const messageTime = message.date * 1000;

      // Определяем пороговое время для старых сообщений
      const ignoreOlderThan = this.getIgnoreThreshold();

      // Проверяем, является ли сообщение старым
      const isOldMessage = messageTime < ignoreOlderThan;

      // Проверяем упомянули ли бота в сообщении
      const isBotMentioned = this.messageParser.isBotMentioned(
        messageText,
        this.botInfo?.username
      );

      // Проверяем, является ли сообщение ответом на сообщение этого бота
      const isReplyToBot = this.messageParser.isReplyToBot(
        message,
        this.botInfo
      );

      // Определяем, является ли сообщение постом канала
      const isChannelPost = this.messageParser.isChannelPost(message);

      // Если это сообщение - пост из канала (всегда отвечаем, даже на старые)
      if (
        isChannelPost &&
        Math.random() < BOT_DEFAULTS.POSTS.COMMENT_PROBABILITY
      ) {
        await this.messageHandlers.commentPost(ctx, messageText);
      }
      // Если это ответ на сообщение бота или упомянули бота конкретно,
      // и сообщение пришло после запуска бота
      else if ((isReplyToBot || isBotMentioned) && !isOldMessage) {
        await this.messageHandlers.handleDirectMessage(ctx, messageText);
      }
      // Если это старое сообщение, логируем его для отладки
      else if (isOldMessage && (isReplyToBot || isBotMentioned)) {
        this.logIgnoredOldMessage(message, messageText);
      }
    } catch (error) {
      console.error(
        `[${this.config.BOT_NAME}] Error in message handler:`,
        error
      );
    }
  }

  /**
   * Возвращает пороговое время для игнорирования старых сообщений
   * @returns Временная метка (timestamp) в миллисекундах
   * @private
   */
  private getIgnoreThreshold(): number {
    // Расчет времени начала периода, с которого мы обрабатываем сообщения
    return this.config.IGNORE_MESSAGES_OLDER_THAN_MINS
      ? Date.now() - this.config.IGNORE_MESSAGES_OLDER_THAN_MINS * 60 * 1000
      : this.startupTime;
  }

  /**
   * Логирует информацию о проигнорированном старом сообщении
   * @param message Объект сообщения
   * @param messageText Текст сообщения
   * @private
   */
  private logIgnoredOldMessage(message: any, messageText: string): void {
    console.log(
      `[${this.config.BOT_NAME}] Игнорирую старое сообщение от ${
        message.from?.username || message.from?.id
      }: ${messageText.substring(0, 50)}...`
    );
  }

  /**
   * Запускает бота
   * @public
   */
  public async launch(): Promise<void> {
    try {
      // Инициализируем бота и настраиваем обработчики
      await this.initialize();

      // Запускаем бота
      await this.bot.launch({
        allowedUpdates: ["message"],
      });

      // Обновляем время запуска после успешного запуска
      this.startupTime = Date.now();

      console.log(
        `[${this.config.BOT_NAME}] Бот успешно запущен в ${new Date(
          this.startupTime
        ).toLocaleString()}`
      );
    } catch (err) {
      console.error(`[${this.config.BOT_NAME}] Ошибка запуска бота:`, err);
      throw err;
    }
  }

  /**
   * Останавливает бота
   * @param signal Сигнал остановки
   * @public
   */
  public stop(signal?: string): void {
    console.log(`[${this.config.BOT_NAME}] Останавливаю бота...`);
    this.bot.stop(signal);
  }
}
