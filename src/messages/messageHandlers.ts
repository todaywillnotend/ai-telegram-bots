import { Context } from "telegraf";
import axios from "axios";
import { BOT_DEFAULTS } from "../constants";
import { ChatMessage, UserContext } from "../types";
import { ApiService } from "../api/apiService";
import { ContextManager } from "../context/contextManager";
import { MessageParser } from "./messageParser";
import { MessageSender } from "./messageSender";
import { BotConfig } from "../types";

export class MessageHandlers {
  private apiService: ApiService;
  private contextManager: ContextManager;
  private messageParser: MessageParser;
  private messageSender: MessageSender;
  private config: BotConfig;
  private botInfo: any;
  private startupTime: number;

  constructor(
    config: BotConfig,
    apiService: ApiService,
    contextManager: ContextManager,
    messageParser: MessageParser,
    messageSender: MessageSender,
    botInfo: any,
    startupTime: number
  ) {
    this.config = config;
    this.apiService = apiService;
    this.contextManager = contextManager;
    this.messageParser = messageParser;
    this.messageSender = messageSender;
    this.botInfo = botInfo;
    this.startupTime = startupTime;
  }

  /**
   * Обрабатывает прямое сообщение пользователя боту
   */
  public async handleDirectMessage(ctx: Context, text: string): Promise<void> {
    const message = ctx.message;
    if (!message) return;

    try {
      console.log(`[${this.config.BOT_NAME}] Получено сообщение:`, text);

      // Создаем ключ пользователя и извлекаем очищенный текст
      const userKey = this.createUserKey(ctx);
      const cleanText = this.messageParser.cleanMentionFromText(
        text,
        this.botInfo?.username
      );

      // Получаем или создаем контекст пользователя
      let userContext = this.contextManager.getUserContext(userKey);

      // Помечаем беседу как активную
      userContext.activeConversation = true;

      // Проверяем, является ли сообщение ответом на пост канала
      await this.checkAndUpdateContextWithReplyInfo(message, userContext);

      // Обрабатываем сообщение пользователя
      await this.processUserMessage(ctx, cleanText, userContext, message);
    } catch (error) {
      await this.handleMessageError(ctx, message, error);
    }
  }

  /**
   * Обрабатывает комментирование поста
   */
  public async commentPost(ctx: Context, postText: string): Promise<void> {
    try {
      const message = ctx.message;
      if (!message) return;

      if (!postText || postText.length < BOT_DEFAULTS.POSTS.MIN_TEXT_LENGTH)
        return;

      console.log(
        `[${this.config.BOT_NAME}] Комментирование поста:`,
        postText.substring(0, 50) + (postText.length > 50 ? "..." : "")
      );

      // Создаем ключ для контекста поста
      const postKey = this.createPostKey(ctx);

      // Определяем тему поста
      const postTopic = await this.apiService.inferPostTopic(postText);
      console.log(`[${this.config.BOT_NAME}] Тема поста: ${postTopic}`);

      // Получаем контекст или создаем новый
      let postContext = this.contextManager.getPostContext(postKey, postTopic);

      // Обрабатываем длинные тексты
      const truncatedPostText = this.truncateTextIfNeeded(
        postText,
        BOT_DEFAULTS.MESSAGES.MAX_SAFE_LENGTH
      );

      // Получаем ответ
      const botComment = await this.apiService.callApiWithRetry([
        { role: "system", content: this.getSystemPrompt() },
        { role: "user", content: this.getPostCommentPrompt(truncatedPostText) },
      ]);

      // Сохраняем в контексте поста
      this.updatePostContext(postContext, truncatedPostText, botComment);

      // Отправляем комментарий
      await this.sendPostComment(ctx, botComment, message.message_id);
    } catch (error) {
      console.error(`[${this.config.BOT_NAME}] Error commenting post:`, error);

      // Простое сообщение об ошибке
      try {
        await ctx.reply("Не могу прокомментировать этот пост 🤔");
      } catch (e) {
        console.error(
          `[${this.config.BOT_NAME}] Failed to send error message:`,
          e
        );
      }
    }
  }

  /**
   * Создает уникальный ключ для контекста пользователя
   */
  private createUserKey(ctx: Context): string {
    const userId = ctx.message?.from ? ctx.message.from.id : "unknown";
    const chatId = ctx.chat?.id || "unknown";
    const botId = this.botInfo?.id || "unknown";
    return `${chatId}_${userId}_${botId}`;
  }

  /**
   * Создает уникальный ключ для контекста поста
   */
  private createPostKey(ctx: Context): string {
    const chatId = ctx.chat?.id || "unknown";
    const messageId = ctx.message?.message_id || "unknown";
    const botId = this.botInfo?.id || "unknown";
    return `post_${chatId}_${messageId}_${botId}`;
  }

  /**
   * Проверяет, является ли сообщение ответом на пост канала и обновляет контекст
   */
  private async checkAndUpdateContextWithReplyInfo(
    message: any,
    userContext: UserContext
  ): Promise<void> {
    if ("reply_to_message" in message && message.reply_to_message) {
      const replyMessage = message.reply_to_message;
      const replyText = this.messageParser.getMessageText(replyMessage);

      if (replyText) {
        const isReplyToChannelPost =
          this.messageParser.isChannelPost(replyMessage);
        if (isReplyToChannelPost) {
          userContext.postTopic = await this.apiService.inferPostTopic(
            replyText
          );
        }
      }
    }
  }

  /**
   * Обрабатывает сообщение пользователя и формирует ответ
   */
  private async processUserMessage(
    ctx: Context,
    text: string,
    userContext: UserContext,
    message: any
  ): Promise<void> {
    // Проверяем длину сообщения пользователя
    const truncatedText = this.truncateTextIfNeeded(
      text,
      BOT_DEFAULTS.MESSAGES.MAX_SAFE_LENGTH
    );

    // Добавляем сообщение пользователя в историю
    userContext.messages.push({ role: "user", content: truncatedText });
    userContext.lastInteraction = Date.now();
    userContext.messageCount++;

    // Ограничиваем длину истории
    this.limitMessageHistory(userContext);

    // Формируем сообщения для API
    const messages = this.prepareMessagesForApi(userContext);

    // Индикатор набора текста
    await this.messageSender.sendTypingIndicator(ctx);

    // Получаем ответ от API
    const botReply = await this.apiService.callApiWithRetry(messages);

    // Проверка и обработка ответа
    const sanitizedReply = this.sanitizeResponse(botReply);

    // Сохраняем ответ бота в контексте
    userContext.messages.push({ role: "assistant", content: sanitizedReply });
    userContext.messageCount++;

    // Отправляем ответ
    await this.messageSender.sendSplitMessage(
      ctx,
      sanitizedReply,
      message.message_id
    );
  }

  /**
   * Обрабатывает ошибки при обработке сообщений
   */
  private async handleMessageError(
    ctx: Context,
    message: any,
    error: any
  ): Promise<void> {
    console.error(
      `[${this.config.BOT_NAME}] Error handling direct message:`,
      error
    );

    // Обработка специфических ошибок
    if (axios.isAxiosError(error)) {
      if (error.response?.status === 429) {
        await ctx.reply(
          "Извини, я сейчас немного перегружен. Попробуй через минуту.",
          // @ts-ignore
          { reply_to_message_id: message.message_id }
        );
        return;
      }

      if (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT") {
        await ctx.reply(
          "Извини, запрос занял слишком много времени. Попробуй задать более краткий вопрос.",
          // @ts-ignore
          { reply_to_message_id: message.message_id }
        );
        return;
      }
    }

    // Общий ответ в случае ошибки
    if (ctx.chat) {
      try {
        await ctx.reply(
          "Ой, что-то пошло не так 🤖 Технические проблемы, попробуй позже.",
          // @ts-ignore
          { reply_to_message_id: message.message_id }
        );
      } catch (replyError) {
        console.error(
          `[${this.config.BOT_NAME}] Error sending error message:`,
          replyError
        );
        // Пробуем отправить без reply
        try {
          await ctx.reply(
            "Ой, что-то пошло не так 🤖 Технические проблемы, попробуй позже."
          );
        } catch (e) {
          console.error(
            `[${this.config.BOT_NAME}] Could not send any error message:`,
            e
          );
        }
      }
    }
  }

  /**
   * Подготавливает сообщения для API
   */
  private prepareMessagesForApi(userContext: UserContext): ChatMessage[] {
    // Проверяем, нужно ли напомнить о настройках
    const needsReminderOfRole =
      userContext.messageCount % BOT_DEFAULTS.MESSAGES.REMINDER_INTERVAL === 0;

    // Начинаем с системного сообщения
    const messages: ChatMessage[] = [
      { role: "system", content: this.getSystemPrompt() },
    ];

    // Если нужно напомнить о роли
    if (needsReminderOfRole) {
      messages.push({
        role: "system",
        content: "Помни о своей роли и придерживайся заданного стиля общения.",
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

    return messages;
  }

  /**
   * Отправляет комментарий к посту
   */
  private async sendPostComment(
    ctx: Context,
    comment: string,
    replyToMessageId: number
  ): Promise<void> {
    try {
      await this.messageSender.sendSplitMessage(ctx, comment, replyToMessageId);
    } catch (error) {
      console.error(
        `[${this.config.BOT_NAME}] Error sending comment, trying without reply:`,
        error
      );
      // Если не получается ответить на сообщение, отправляем без reply
      await this.messageSender.sendSplitMessage(ctx, comment);
    }
  }

  /**
   * Обновляет контекст поста
   */
  private updatePostContext(
    postContext: UserContext,
    postText: string,
    botComment: string
  ): void {
    postContext.messages.push({ role: "user", content: postText });
    postContext.messages.push({ role: "assistant", content: botComment });
    postContext.messageCount += 2;
    postContext.lastInteraction = Date.now();

    // Ограничиваем длину истории
    this.limitMessageHistory(postContext);
  }

  /**
   * Ограничивает длину истории сообщений в контексте
   */
  private limitMessageHistory(context: UserContext): void {
    if (context.messages.length > BOT_DEFAULTS.HISTORY.MAX_LENGTH) {
      context.messages = context.messages.slice(
        -BOT_DEFAULTS.HISTORY.MAX_LENGTH
      );
    }
  }

  /**
   * Возвращает наиболее релевантные сообщения из истории
   */
  private getRelevantMessages(messages: ChatMessage[]): ChatMessage[] {
    if (messages.length <= BOT_DEFAULTS.HISTORY.RELEVANT_LENGTH) {
      return messages;
    }

    // Берем последние N сообщений
    return messages.slice(-BOT_DEFAULTS.HISTORY.RELEVANT_LENGTH);
  }

  /**
   * Проверяет ответ на соответствие правилам
   */
  private sanitizeResponse(response: string): string {
    // Простая проверка, что ответ не слишком короткий
    if (response.length < 5) {
      return "Извини, не могу сформулировать подходящий ответ. Можешь уточнить вопрос?";
    }

    // Проверка на слишком длинный ответ
    if (response.length > BOT_DEFAULTS.MESSAGES.MAX_SAFE_LENGTH) {
      console.warn(
        `[${this.config.BOT_NAME}] Unusually long response (${response.length} chars)`
      );
      return (
        response.substring(0, 4000) +
        "\n\n[Ответ обрезан из-за слишком большой длины]"
      );
    }

    return response;
  }

  /**
   * Обрезает длинный текст при необходимости
   */
  private truncateTextIfNeeded(text: string, maxLength: number): string {
    if (text.length <= maxLength) {
      return text;
    }
    return text.substring(0, maxLength) + "... [текст сокращен из-за длины]";
  }

  /**
   * Возвращает системный промпт
   */
  private getSystemPrompt(): string {
    return this.config.SYSTEM_PROMPT;
  }

  /**
   * Возвращает промпт для комментария к посту
   */
  private getPostCommentPrompt(postText: string): string {
    return this.config.POST_COMMENT_PROMPT_TEMPLATE.replace(
      "{postText}",
      postText
    );
  }

  public updateBotInfo(botInfo: any): void {
    this.botInfo = botInfo;
  }
}
