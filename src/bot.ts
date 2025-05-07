import { Telegraf, Context } from "telegraf";
import axios from "axios";
import * as dotenv from "dotenv";
import { BotConfig } from "./types";

dotenv.config();

interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

interface UserContext {
  messages: ChatMessage[];
  lastInteraction: number;
  postTopic?: string;
  messageCount: number; // Счетчик сообщений для периодической "настройки"
  activeConversation: boolean; // Флаг активного разговора
}

// Базовое время жизни контекста (30 минут)
const BASE_CONTEXT_TTL = 30 * 60 * 1000;
// Расширенное время жизни для активных бесед (2 часа)
const ACTIVE_CONTEXT_TTL = 2 * 60 * 60 * 1000;

// История сообщений
const DEFAULT_HISTORY_LENGTH = 15;
const MAX_HISTORY_LENGTH = 30;
const RELEVANT_HISTORY_LENGTH = 10; // Количество сообщений для отправки в API

// Вероятность комментирования поста (100%)
const POST_COMMENT_PROBABILITY = 1;

// Количество сообщений, после которого повторяем настройку
const REMINDER_INTERVAL = 10;

// Максимальная длина сообщения Telegram
const MAX_MESSAGE_LENGTH = 4096;

export class TelegramBot {
  private bot: Telegraf;
  private config: BotConfig;
  private userContexts: Map<string, UserContext>;
  private postContexts: Map<string, UserContext>;
  private botInfo: any;
  private startupTime: number;

  constructor(config: BotConfig) {
    this.config = config;
    this.userContexts = new Map<string, UserContext>();
    this.postContexts = new Map<string, UserContext>();
    this.bot = new Telegraf(this.config.BOT_TOKEN);
    this.startupTime = Date.now();
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

  // Улучшенный метод определения темы поста с использованием NLP-подхода
  private async inferPostTopic(postText: string): Promise<string> {
    // Если пост слишком короткий, возвращаем общую тему
    if (postText.length < 10) {
      return "Общая тема";
    }

    try {
      // Используем LLM для определения темы
      const response = await axios.post(
        "https://api.deepseek.com/chat/completions",
        {
          model: "deepseek-chat",
          messages: [
            {
              role: "system",
              content:
                "Определи основную тему текста в 3-7 словах. Ответь только темой, без дополнительных пояснений.",
            },
            { role: "user", content: postText.substring(0, 500) }, // Берем только первые 500 символов
          ],
        },
        {
          headers: {
            Authorization: `Bearer ${this.config.DEEPSEEK_API_KEY}`,
            "Content-Type": "application/json",
          },
        }
      );

      let topic = response.data.choices[0].message.content.trim();
      // Убираем лишние кавычки и точки
      topic = topic.replace(/["'.]+$|^["'.]+/g, "");

      return topic || "Общая тема";
    } catch (error) {
      console.error(`[${this.config.BOT_NAME}] Error inferring topic:`, error);

      // Фолбэк на простой метод в случае ошибки
      const topicMatch = postText.match(/^(.{1,50})[.!?]|^(.{1,50})/);
      return topicMatch ? topicMatch[0] : "Общая тема";
    }
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
      const postTopic = await this.inferPostTopic(postText);
      console.log(`[${this.config.BOT_NAME}] Тема поста: ${postTopic}`);

      // Получаем контекст или создаем новый
      let postContext = this.getPostContext(postKey, postTopic);

      // Проверяем длину поста и обрабатываем длинные тексты
      const truncatedPostText = this.truncateTextIfNeeded(postText, 4000);

      // Формируем запрос на комментирование поста
      const response = await axios.post(
        "https://api.deepseek.com/chat/completions",
        {
          model: "deepseek-chat",
          messages: [
            { role: "system", content: this.getSystemPrompt() },
            {
              role: "user",
              content: this.getPostCommentPrompt(truncatedPostText),
            },
          ],
          max_tokens: 1000, // Ограничиваем длину ответа
        },
        {
          headers: {
            Authorization: `Bearer ${this.config.DEEPSEEK_API_KEY}`,
            "Content-Type": "application/json",
          },
          timeout: 30000, // 30 секунд таймаут
        }
      );

      const botComment = response.data.choices[0].message.content;

      // Сохраняем в контексте поста
      postContext.messages.push({ role: "user", content: truncatedPostText });
      postContext.messages.push({ role: "assistant", content: botComment });
      postContext.messageCount += 2;

      // Ограничиваем длину истории
      if (postContext.messages.length > MAX_HISTORY_LENGTH) {
        postContext.messages = postContext.messages.slice(-MAX_HISTORY_LENGTH);
      }

      // Отправляем комментарий как ответ на пост, разбивая на части при необходимости
      await this.sendSplitMessage(ctx, botComment, message.message_id);
    } catch (error) {
      console.error(`[${this.config.BOT_NAME}] Error commenting post:`, error);

      // Обработка специфических ошибок API
      if (axios.isAxiosError(error) && error.response) {
        console.error(
          `API error: ${error.response.status}`,
          error.response.data
        );

        // Обработка превышения rate limit
        if (error.response.status === 429) {
          console.log(
            `[${this.config.BOT_NAME}] Rate limit exceeded. Waiting before retrying.`
          );
          // Можно реализовать отложенную повторную попытку
        }
      }
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

      // Отмечаем беседу как активную
      userContext.activeConversation = true;

      // Определяем тему поста, если это ответ на пост из канала
      if ("reply_to_message" in message && message.reply_to_message) {
        const replyMessage = message.reply_to_message;

        // Получаем текст из сообщения, на которое отвечают
        const replyText = this.getMessageText(replyMessage);

        if (replyText) {
          // Проверяем, является ли сообщение, на которое отвечают, постом канала
          const isReplyToChannelPost = this.isChannelPost(replyMessage);

          if (isReplyToChannelPost) {
            userContext.postTopic = await this.inferPostTopic(replyText);
          }
        }
      }

      // Проверяем длину сообщения пользователя
      const truncatedText = this.truncateTextIfNeeded(cleanText, 4000);

      // Добавляем сообщение пользователя в историю
      userContext.messages.push({ role: "user", content: truncatedText });
      userContext.lastInteraction = Date.now();
      userContext.messageCount++;

      // Проверяем, нужно ли напомнить о настройках
      const needsReminderOfRole =
        userContext.messageCount % REMINDER_INTERVAL === 0;

      // Ограничиваем длину истории
      if (userContext.messages.length > MAX_HISTORY_LENGTH) {
        userContext.messages = userContext.messages.slice(-MAX_HISTORY_LENGTH);
      }

      // Формируем сообщения для API
      const systemMessage: ChatMessage = {
        role: "system",
        content: this.getSystemPrompt(),
      };

      // Начинаем с системного сообщения
      const messages: ChatMessage[] = [systemMessage];

      // Если нужно напомнить о роли
      if (needsReminderOfRole) {
        messages.push({
          role: "system",
          content:
            "Помни о своей роли и придерживайся заданного стиля общения.",
        });
      }

      // Добавляем контекст темы поста, если она есть
      if (userContext.postTopic) {
        messages.push({
          role: "system",
          content: `Текущая тема обсуждения: ${userContext.postTopic}`,
        });
      }

      // Добавляем историю сообщений, выбирая наиболее релевантные
      const relevantMessages = this.getRelevantMessages(userContext.messages);
      messages.push(...relevantMessages);

      // Индикатор набора текста перед отправкой запроса
      await ctx.telegram.sendChatAction(chatId, "typing");

      // Вызов API DeepSeek с обработкой токенов
      const response = await axios.post(
        "https://api.deepseek.com/chat/completions",
        {
          model: "deepseek-chat",
          messages: messages,
          max_tokens: 1500, // Ограничиваем длину ответа
        },
        {
          headers: {
            Authorization: `Bearer ${this.config.DEEPSEEK_API_KEY}`,
            "Content-Type": "application/json",
          },
          timeout: 30000, // 30 секунд таймаут
        }
      );

      const botReply = response.data.choices[0].message.content;

      // Проверка соответствия ответа правилам (простая реализация)
      const sanitizedReply = this.sanitizeResponse(botReply);

      // Сохраняем ответ бота в контексте
      userContext.messages.push({ role: "assistant", content: sanitizedReply });
      userContext.messageCount++;

      // Обновляем контекст пользователя
      this.userContexts.set(userKey, userContext);

      // Отправляем ответ, разбивая длинные сообщения
      await this.sendSplitMessage(ctx, sanitizedReply, message.message_id);
    } catch (error) {
      console.error(
        `[${this.config.BOT_NAME}] Error handling direct message:`,
        error
      );

      // Обработка специфических ошибок
      if (axios.isAxiosError(error)) {
        if (error.response?.status === 429) {
          await ctx.reply(
            "Извини, я сейчас немного перегружен. Попробуй через минуту.",
            {
              // @ts-ignore
              reply_to_message_id: message.message_id,
            }
          );
          return;
        }

        if (error.code === "ECONNABORTED") {
          await ctx.reply(
            "Извини, запрос занял слишком много времени. Попробуй задать более краткий вопрос.",
            {
              // @ts-ignore
              reply_to_message_id: message.message_id,
            }
          );
          return;
        }
      }

      // Общий ответ в случае ошибки
      if (ctx.chat) {
        await ctx.reply(
          "Ой, что-то пошло не так 🤖 Технические проблемы, попробуй позже.",
          {
            // @ts-ignore
            reply_to_message_id: message.message_id,
          }
        );
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
        messageCount: 0,
        activeConversation: false,
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
        messageCount: 0,
        activeConversation: false,
      });
    } else if (postTopic) {
      // Обновляем тему, если она предоставлена
      const context = this.postContexts.get(postKey)!;
      context.postTopic = postTopic;
      context.lastInteraction = Date.now();
    }

    return this.postContexts.get(postKey)!;
  }

  // Функция для очистки старых контекстов с динамическим TTL
  private cleanupOldContexts() {
    const now = Date.now();

    // Очистка пользовательских контекстов
    for (const [key, context] of this.userContexts.entries()) {
      const ttl = context.activeConversation
        ? ACTIVE_CONTEXT_TTL
        : BASE_CONTEXT_TTL;
      if (now - context.lastInteraction > ttl) {
        this.userContexts.delete(key);
      }
    }

    // Очистка контекстов постов
    for (const [key, context] of this.postContexts.entries()) {
      const ttl = context.activeConversation
        ? ACTIVE_CONTEXT_TTL
        : BASE_CONTEXT_TTL;
      if (now - context.lastInteraction > ttl) {
        this.postContexts.delete(key);
      }
    }
  }

  // Функция для выбора наиболее релевантных сообщений из истории
  private getRelevantMessages(messages: ChatMessage[]): ChatMessage[] {
    if (messages.length <= RELEVANT_HISTORY_LENGTH) {
      return messages;
    }

    // Стратегия 1: Берем последние N сообщений (самые недавние)
    return messages.slice(-RELEVANT_HISTORY_LENGTH);

    // Альтернативная стратегия (можно реализовать):
    // Взять первые 2 сообщения для контекста + последние (N-2) сообщений
  }

  // Функция для проверки ответа на соответствие правилам
  private sanitizeResponse(response: string): string {
    // Здесь можно добавить фильтрацию для соблюдения правил
    // Например, удаление определенных фраз, проверка на нежелательный контент и т.д.

    // Простая проверка, что ответ не слишком короткий
    if (response.length < 5) {
      return "Извини, не могу сформулировать подходящий ответ. Можешь уточнить вопрос?";
    }

    return response;
  }

  // Функция для отправки длинного сообщения с разбиением
  private async sendSplitMessage(
    ctx: Context,
    text: string,
    replyToMessageId?: number
  ) {
    if (text.length <= MAX_MESSAGE_LENGTH) {
      await ctx.reply(text, {
        // @ts-ignore
        reply_to_message_id: replyToMessageId,
      });
      return;
    }

    // Разбиваем на части
    const parts = [];
    let remainingText = text;

    while (remainingText.length > 0) {
      // Находим хорошее место для разбиения (после предложения или абзаца)
      let splitIndex = MAX_MESSAGE_LENGTH;
      if (splitIndex < remainingText.length) {
        // Ищем ближайший конец предложения или абзаца
        const sentenceEnd = remainingText.lastIndexOf(". ", splitIndex);
        const lineBreak = remainingText.lastIndexOf("\n", splitIndex);

        if (sentenceEnd > 0 && sentenceEnd > lineBreak) {
          splitIndex = sentenceEnd + 1; // +1 чтобы включить точку
        } else if (lineBreak > 0) {
          splitIndex = lineBreak + 1; // +1 чтобы включить перенос строки
        } else {
          // Если не нашли удобного места, ищем пробел
          const spaceIndex = remainingText.lastIndexOf(" ", splitIndex);
          if (spaceIndex > 0) {
            splitIndex = spaceIndex + 1; // +1 чтобы включить пробел
          }
        }
      }

      // Добавляем часть
      parts.push(remainingText.substring(0, splitIndex));
      remainingText = remainingText.substring(splitIndex);
    }

    // Отправляем каждую часть
    for (let i = 0; i < parts.length; i++) {
      const isFirstPart = i === 0;
      await ctx.reply(parts[i], {
        // @ts-ignore
        reply_to_message_id: isFirstPart ? replyToMessageId : undefined,
      });

      // Небольшая задержка между сообщениями, чтобы избежать флуда
      if (i < parts.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }

  // Функция для обрезки длинного текста
  private truncateTextIfNeeded(text: string, maxLength: number): string {
    if (text.length <= maxLength) {
      return text;
    }

    // Обрезаем и добавляем пометку, что текст был сокращен
    return text.substring(0, maxLength) + "... [текст сокращен из-за длины]";
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
