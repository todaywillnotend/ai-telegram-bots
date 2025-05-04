import { Telegraf, Context } from "telegraf";
import axios from "axios";
import * as dotenv from "dotenv";
import { BotConfig } from "./types";

dotenv.config();

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface UserContext {
  messages: ChatMessage[];
  lastInteraction: number;
  postTopic?: string;
}

// Время жизни контекста (30 минут)
const CONTEXT_TTL = 30 * 60 * 1000;

// Максимальное количество сообщений в истории
const MAX_HISTORY_LENGTH = 10;

// Вероятность комментирования поста (100%)
const POST_COMMENT_PROBABILITY = 1;

export class TelegramBot {
  private bot: Telegraf;
  private config: BotConfig;
  private userContexts: Map<string, UserContext>;
  private postContexts: Map<string, UserContext>;
  private botInfo: any;
  private startupTime: number; // Время запуска бота

  constructor(config: BotConfig) {
    this.config = config;
    this.userContexts = new Map<string, UserContext>();
    this.postContexts = new Map<string, UserContext>();
    this.bot = new Telegraf(this.config.BOT_TOKEN);
    this.startupTime = Date.now(); // Инициализируем время запуска
    this.setupHandlers();
  }

  private setupHandlers() {
    // Получаем информацию о боте при запуске
    this.bot.telegram.getMe().then((info) => {
      this.botInfo = info;
      console.log(
        `[${this.config.BOT_NAME}] Бот @${info.username} готов к работе`
      );
    });

    this.bot.on("message", async (ctx) => {
      try {
        const message = ctx.message;
        if (!message) return;

        // Получаем текст сообщения или подпись к медиа
        const messageText = this.getMessageText(message);

        // Пропускаем если нет текста или подписи
        if (!messageText) return;

        // Получаем время сообщения (в секундах, преобразуем в миллисекунды)
        const messageTime = message.date * 1000;

        // Расчет времени начала периода, с которого мы обрабатываем сообщения
        const ignoreOlderThan = this.config.IGNORE_MESSAGES_OLDER_THAN_MINS
          ? Date.now() - this.config.IGNORE_MESSAGES_OLDER_THAN_MINS * 60 * 1000
          : this.startupTime;

        // Проверяем, является ли сообщение старым
        const isOldMessage = messageTime < ignoreOlderThan;

        // Проверяем упомянули ли бота в сообщении
        const isBotMentioned =
          this.botInfo && messageText.includes(`@${this.botInfo.username}`);

        // Проверяем, является ли сообщение ответом на сообщение этого бота
        const isReplyToBot = this.isReplyToBot(message);

        // Определяем, является ли сообщение постом канала
        const isAnyKindOfChannelPost = this.isChannelPost(message);

        // Если это сообщение - пост из канала (всегда отвечаем, даже на старые)
        if (
          isAnyKindOfChannelPost &&
          Math.random() < POST_COMMENT_PROBABILITY
        ) {
          await this.commentPost(ctx, messageText);
        }
        // Если это ответ на сообщение бота или упомянули бота конкретно,
        // и сообщение пришло после запуска бота
        else if ((isReplyToBot || isBotMentioned) && !isOldMessage) {
          await this.handleDirectMessage(ctx, messageText);
        }
        // Если это старое сообщение, логируем его для отладки
        else if (isOldMessage && (isReplyToBot || isBotMentioned)) {
          console.log(
            `[${this.config.BOT_NAME}] Игнорирую старое сообщение от ${
              message.from?.username || message.from?.id
            }: ${messageText.substring(0, 50)}...`
          );
        }
      } catch (error) {
        console.error(
          `[${this.config.BOT_NAME}] Error in message handler:`,
          error
        );
      }
    });
  }

  // Вспомогательный метод для получения текста из разных типов сообщений
  private getMessageText(message: any): string | null {
    if ("text" in message && message.text) {
      return message.text;
    }
    if ("caption" in message && message.caption) {
      return message.caption;
    }
    return null;
  }

  // Проверка, является ли сообщение ответом на сообщение бота
  private isReplyToBot(message: any): boolean {
    if (!("reply_to_message" in message) || !message.reply_to_message) {
      return false;
    }

    const replyMsg = message.reply_to_message;
    return (
      "from" in replyMsg &&
      replyMsg.from &&
      replyMsg.from.id === this.botInfo?.id
    );
  }

  // Проверка, является ли сообщение постом из канала
  private isChannelPost(message: any): boolean {
    // Перенаправленное сообщение из канала
    const isForwardedChannel =
      "forward_from_chat" in message &&
      message.forward_from_chat &&
      message.forward_from_chat.type === "channel";

    // Автоматически добавленный пост из связанного канала
    const isAutoAddedPost =
      !message.from &&
      "sender_chat" in message &&
      message.sender_chat &&
      message.sender_chat.type === "channel";

    return isForwardedChannel || isAutoAddedPost;
  }

  private getSystemPrompt() {
    return this.config.SYSTEM_PROMPT;
  }

  private getPostCommentPrompt(postText: string) {
    return this.config.POST_COMMENT_PROMPT_TEMPLATE.replace(
      "{postText}",
      postText
    );
  }

  private async commentPost(ctx: Context, postText: string) {
    try {
      const message = ctx.message;
      if (!message) return;

      if (!postText || postText.length < 5) return; // Игнорируем слишком короткие посты

      console.log(
        `[${this.config.BOT_NAME}] Комментирование поста:`,
        postText.substring(0, 50) + (postText.length > 50 ? "..." : "")
      );

      // Создаем ключ для контекста поста
      const chatId = ctx.chat?.id || "unknown";
      const messageId = message.message_id;
      const botId = this.botInfo?.id || "unknown";
      const postKey = `post_${chatId}_${messageId}_${botId}`;

      // Определяем тему поста
      const postTopic = this.inferPostTopic(postText);

      // Получаем контекст или создаем новый
      let postContext = this.getPostContext(postKey, postTopic);

      // Формируем запрос на комментирование поста
      const response = await axios.post(
        "https://api.deepseek.com/chat/completions",
        {
          model: "deepseek-chat",
          messages: [
            { role: "user", content: this.getSystemPrompt() },
            { role: "user", content: this.getPostCommentPrompt(postText) },
          ],
        },
        {
          headers: {
            Authorization: `Bearer ${this.config.DEEPSEEK_API_KEY}`,
            "Content-Type": "application/json",
          },
        }
      );

      const botComment = response.data.choices[0].message.content;

      // Сохраняем в контексте поста
      postContext.messages.push({ role: "user", content: postText });
      postContext.messages.push({ role: "assistant", content: botComment });

      // Ограничиваем длину истории
      if (postContext.messages.length > MAX_HISTORY_LENGTH) {
        postContext.messages = postContext.messages.slice(-MAX_HISTORY_LENGTH);
      }

      // Отправляем комментарий как ответ на пост
      await ctx.reply(botComment, {
        // @ts-ignore
        reply_to_message_id: message.message_id,
      });
    } catch (error) {
      console.error(`[${this.config.BOT_NAME}] Error commenting post:`, error);
    }
  }

  private async handleDirectMessage(ctx: Context, text: string) {
    const message = ctx.message;
    if (!message) return;

    try {
      console.log(`[${this.config.BOT_NAME}] Получено сообщение:`, text);

      // Создаем уникальный ключ для пользователя (chatId_userId_botId)
      const userId = message.from ? message.from.id : "unknown";
      const chatId = ctx.chat?.id || "unknown";
      const botId = this.botInfo?.id || "unknown";
      const userKey = `${chatId}_${userId}_${botId}`;

      // Очистка текста от упоминания бота
      let cleanText = text;
      if (this.botInfo && text.includes(`@${this.botInfo.username}`)) {
        cleanText = text.replace(`@${this.botInfo.username}`, "").trim();
      }

      // Получаем или создаем контекст для пользователя
      let userContext = this.getUserContext(userKey);

      // Определяем тему поста, если это ответ на пост из канала
      if ("reply_to_message" in message && message.reply_to_message) {
        const replyMessage = message.reply_to_message;

        // Получаем текст из сообщения, на которое отвечают
        const replyText = this.getMessageText(replyMessage);

        if (replyText) {
          // Проверяем, является ли сообщение, на которое отвечают, постом канала
          const isReplyToChannelPost = this.isChannelPost(replyMessage);

          if (isReplyToChannelPost) {
            userContext.postTopic = this.inferPostTopic(replyText);
          }
        }
      }

      // Добавляем сообщение пользователя в историю
      userContext.messages.push({ role: "user", content: cleanText });
      userContext.lastInteraction = Date.now();

      // Ограничиваем длину истории
      if (userContext.messages.length > MAX_HISTORY_LENGTH) {
        userContext.messages = userContext.messages.slice(-MAX_HISTORY_LENGTH);
      }

      // Формируем запрос с учетом контекста и темы поста
      const messages: ChatMessage[] = [
        { role: "user", content: this.getSystemPrompt() },
      ];

      // Добавляем контекст темы поста, если она есть
      if (userContext.postTopic) {
        messages.push({
          role: "user",
          content: `Текущая тема обсуждения: ${userContext.postTopic}`,
        });
      }

      // Добавляем историю сообщений
      messages.push(...userContext.messages);

      // Вызов API DeepSeek
      const response = await axios.post(
        "https://api.deepseek.com/chat/completions",
        {
          model: "deepseek-chat",
          messages: messages,
        },
        {
          headers: {
            Authorization: `Bearer ${this.config.DEEPSEEK_API_KEY}`,
            "Content-Type": "application/json",
          },
        }
      );

      const botReply = response.data.choices[0].message.content;

      // Сохраняем ответ бота в контексте
      userContext.messages.push({ role: "assistant", content: botReply });

      // Обновляем контекст пользователя
      this.userContexts.set(userKey, userContext);

      // Отправляем ответ
      await ctx.reply(botReply, {
        // @ts-ignore
        reply_to_message_id: message.message_id,
      });
    } catch (error) {
      console.error(
        `[${this.config.BOT_NAME}] Error handling direct message:`,
        error
      );

      // Ответ в случае ошибки
      if (ctx.chat) {
        await ctx.reply("Ой, что-то пошло не так 🤖", {
          // @ts-ignore
          reply_to_message_id: message.message_id,
        });
      }
    }
  }

  // Функция для получения контекста пользователя
  private getUserContext(userKey: string): UserContext {
    // Очистка старых контекстов
    this.cleanupOldContexts();

    // Получаем существующий контекст или создаем новый
    if (!this.userContexts.has(userKey)) {
      this.userContexts.set(userKey, {
        messages: [],
        lastInteraction: Date.now(),
      });
    }

    return this.userContexts.get(userKey)!;
  }

  // Функция для получения контекста поста
  private getPostContext(postKey: string, postTopic?: string): UserContext {
    // Очистка старых контекстов
    this.cleanupOldContexts();

    // Получаем существующий контекст или создаем новый
    if (!this.postContexts.has(postKey)) {
      this.postContexts.set(postKey, {
        messages: [],
        lastInteraction: Date.now(),
        postTopic: postTopic,
      });
    } else if (postTopic) {
      // Обновляем тему, если она предоставлена
      const context = this.postContexts.get(postKey)!;
      context.postTopic = postTopic;
      context.lastInteraction = Date.now();
    }

    return this.postContexts.get(postKey)!;
  }

  // Функция для очистки старых контекстов
  private cleanupOldContexts() {
    const now = Date.now();

    // Очистка пользовательских контекстов
    for (const [key, context] of this.userContexts.entries()) {
      if (now - context.lastInteraction > CONTEXT_TTL) {
        this.userContexts.delete(key);
      }
    }

    // Очистка контекстов постов
    for (const [key, context] of this.postContexts.entries()) {
      if (now - context.lastInteraction > CONTEXT_TTL) {
        this.postContexts.delete(key);
      }
    }
  }

  // Функция для определения темы поста
  private inferPostTopic(text: string): string {
    // Простая реализация - берем первые 50 символов или до первого знака препинания
    const topicMatch = text.match(/^(.{1,50})[.!?]|^(.{1,50})/);
    return topicMatch ? topicMatch[0] : "Общая тема";
  }

  // Запуск бота
  public async launch() {
    try {
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

      // Периодическая очистка старых контекстов каждые 5 минут
      setInterval(() => this.cleanupOldContexts(), 5 * 60 * 1000);
    } catch (err) {
      console.error(`[${this.config.BOT_NAME}] Ошибка запуска бота:`, err);
    }
  }

  // Остановка бота
  public stop(signal: string) {
    this.bot.stop(signal);
  }
}
