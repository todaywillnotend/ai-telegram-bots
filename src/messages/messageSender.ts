import { Context } from "telegraf";
import { BOT_DEFAULTS } from "../constants";

/**
 * Класс для отправки сообщений в Telegram
 * Отвечает за форматирование, разбиение длинных сообщений и обработку ошибок при отправке
 */
export class MessageSender {
  private botName: string;

  constructor(botName: string) {
    this.botName = botName;
  }

  /**
   * Отправляет индикатор набора текста
   * @param ctx Контекст Telegraf
   * @returns Promise, который разрешается после отправки индикатора
   */
  public async sendTypingIndicator(ctx: Context): Promise<void> {
    try {
      const chatId = ctx.chat?.id;
      if (!chatId) return;

      await ctx.telegram.sendChatAction(chatId, "typing");
    } catch (error) {
      console.error(`[${this.botName}] Error sending typing indicator:`, error);
      // Игнорируем ошибки при отправке индикатора набора
    }
  }

  /**
   * Отправляет сообщение, разбивая его на части, если оно слишком длинное
   * @param ctx Контекст Telegraf
   * @param text Текст для отправки
   * @param replyToMessageId ID сообщения, на которое нужно ответить (опционально)
   * @returns Promise, который разрешается после отправки всех частей сообщения
   */
  public async sendSplitMessage(
    ctx: Context,
    text: string,
    replyToMessageId?: number
  ): Promise<void> {
    // Проверка на пустой ответ или только пробелы. Иногда deepseek возвращает пустые скобки
    if (!text || text.trim() === "" || text === "[]") {
      console.warn(`[${this.botName}] Prevented sending empty message`);
      return;
    }

    // Проверка на сильно длинный ответ (возможно, ошибка)
    if (text.length > BOT_DEFAULTS.MESSAGES.MAX_SAFE_LENGTH * 5) {
      console.warn(
        `[${this.botName}] Extremely long message (${text.length} chars), truncating`
      );
      text =
        text.substring(0, BOT_DEFAULTS.MESSAGES.MAX_LENGTH) +
        "... [сообщение обрезано из-за аномальной длины]";
    }

    // Если сообщение помещается целиком
    if (text.length <= BOT_DEFAULTS.MESSAGES.MAX_LENGTH) {
      await this.sendSingleMessage(ctx, text, replyToMessageId);
      return;
    }

    // Разбиваем длинное сообщение на части
    const parts = this.splitMessageIntoParts(text);

    // Отправляем части с обработкой ошибок
    await this.sendMessageParts(ctx, parts, replyToMessageId);
  }

  /**
   * Отправляет сообщение с повторными попытками в случае ошибки
   * @param ctx Контекст Telegraf
   * @param text Текст для отправки
   * @param replyToMessageId ID сообщения, на которое нужно ответить (опционально)
   * @param retries Количество повторных попыток
   * @returns Promise, который разрешается после отправки сообщения
   */
  public async sendWithRetry(
    ctx: Context,
    text: string,
    replyToMessageId?: number,
    retries: number = 2
  ): Promise<void> {
    let lastError;

    for (let i = 0; i <= retries; i++) {
      try {
        await ctx.reply(text, {
          // @ts-ignore
          reply_to_message_id: replyToMessageId,
        });
        return; // Успешная отправка
      } catch (error) {
        lastError = error;

        // Если это последняя попытка с reply_to, пробуем без него
        if (i === retries - 1 && replyToMessageId) {
          try {
            await ctx.reply(text);
            return; // Успешная отправка без reply_to
          } catch (err) {
            // Продолжаем с последней попыткой и задержкой
            lastError = err;
          }
        }

        // Добавляем задержку перед повтором (кроме последней попытки)
        if (i < retries) {
          await this.delay(1000 * (i + 1));
        }
      }
    }

    // Если все попытки не удались
    console.error(
      `[${this.botName}] Failed to send message after ${retries} retries:`,
      lastError
    );
    throw lastError;
  }

  /**
   * Отправляет сообщение об ошибке с обработкой исключений
   * @param ctx Контекст Telegraf
   * @param errorMessage Сообщение об ошибке
   * @param replyToMessageId ID сообщения, на которое нужно ответить (опционально)
   */
  public async sendErrorMessage(
    ctx: Context,
    errorMessage: string,
    replyToMessageId?: number
  ): Promise<void> {
    try {
      await ctx.reply(errorMessage, {
        // @ts-ignore
        reply_to_message_id: replyToMessageId,
      });
    } catch (error) {
      console.error(
        `[${this.botName}] Error sending error message with reply:`,
        error
      );

      // Пробуем отправить без reply
      try {
        await ctx.reply(errorMessage);
      } catch (e) {
        console.error(`[${this.botName}] Failed to send any error message:`, e);
      }
    }
  }

  /**
   * Отправляет одиночное сообщение с обработкой ошибок
   * @param ctx Контекст Telegraf
   * @param text Текст для отправки
   * @param replyToMessageId ID сообщения, на которое нужно ответить (опционально)
   * @private
   */
  private async sendSingleMessage(
    ctx: Context,
    text: string,
    replyToMessageId?: number
  ): Promise<void> {
    try {
      await ctx.reply(text, {
        // @ts-ignore
        reply_to_message_id: replyToMessageId,
      });
    } catch (error) {
      console.error(`[${this.botName}] Error sending message:`, error);

      // Пробуем отправить без reply_to в случае ошибки
      try {
        await ctx.reply(text);
      } catch (err) {
        console.error(
          `[${this.botName}] Failed to send message even without reply_to:`,
          err
        );
        throw err; // Пробрасываем ошибку для обработки выше
      }
    }
  }

  /**
   * Разбивает длинное сообщение на части с умным разделением по предложениям
   * @param text Текст для разбиения
   * @returns Массив строк - частей сообщения
   * @private
   */
  private splitMessageIntoParts(text: string): string[] {
    const parts: string[] = [];
    let currentPart = "";

    // Разбиваем текст на предложения
    const sentences = text.split(/(?<=\.|\?|\!|\n)\s+/);

    for (const sentence of sentences) {
      // Если добавление предложения превысит лимит
      if (
        currentPart.length + sentence.length >
        BOT_DEFAULTS.MESSAGES.MAX_LENGTH - 30
      ) {
        if (currentPart.length > 0) {
          parts.push(currentPart.trim());
          currentPart = "";
        }

        // Если предложение само по себе слишком длинное
        if (sentence.length > BOT_DEFAULTS.MESSAGES.MAX_LENGTH) {
          let remainingSentence = sentence;
          while (remainingSentence.length > 0) {
            const chunk = remainingSentence.substring(
              0,
              BOT_DEFAULTS.MESSAGES.MAX_LENGTH - 30
            );
            parts.push(chunk + "...");
            remainingSentence =
              "..." + remainingSentence.substring(chunk.length);
          }
        } else {
          currentPart = sentence;
        }
      } else {
        currentPart += (currentPart.length > 0 ? " " : "") + sentence;
      }
    }

    // Добавляем последнюю часть, если что-то осталось
    if (currentPart.length > 0) {
      parts.push(currentPart.trim());
    }

    // Добавляем номера частей, если их больше одной
    if (parts.length > 1) {
      parts.forEach((part, index) => {
        parts[index] = `(${index + 1}/${parts.length}) ${part}`;
      });
    }

    return parts;
  }

  /**
   * Отправляет части сообщения последовательно
   * @param ctx Контекст Telegraf
   * @param parts Массив частей сообщения
   * @param replyToMessageId ID сообщения, на которое нужно ответить (опционально)
   * @private
   */
  private async sendMessageParts(
    ctx: Context,
    parts: string[],
    replyToMessageId?: number
  ): Promise<void> {
    for (let i = 0; i < parts.length; i++) {
      try {
        const isFirstPart = i === 0;
        await ctx.reply(parts[i], {
          // @ts-ignore
          reply_to_message_id: isFirstPart ? replyToMessageId : undefined,
        });

        // Небольшая задержка между сообщениями
        if (i < parts.length - 1) {
          await this.delay(500);
        }
      } catch (error) {
        console.error(
          `[${this.botName}] Error sending message part ${i + 1}:`,
          error
        );

        // Пробуем отправить без reply_to
        try {
          await ctx.reply(parts[i]);
        } catch (err) {
          console.error(
            `[${this.botName}] Failed to send part ${
              i + 1
            } even without reply_to:`,
            err
          );

          // Продолжаем с другими частями даже при ошибке
        }
      }
    }
  }

  /**
   * Создает задержку выполнения
   * @param ms Время задержки в миллисекундах
   * @returns Promise, который разрешается после указанной задержки
   * @private
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
