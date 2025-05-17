/**
 * Класс для разбора и анализа сообщений Telegram
 * Отвечает за извлечение текста, проверку типов сообщений и работу с упоминаниями
 */
export class MessageParser {
  /**
   * Получает текст из различных типов сообщений
   * @param message Объект сообщения Telegram
   * @returns Строка с текстом сообщения или null, если текст отсутствует
   */
  public getMessageText(message: any): string | null {
    if (!message) return null;

    // Проверяем обычный текст
    if ("text" in message && message.text) {
      return message.text;
    }

    // Проверяем подпись к медиа
    if ("caption" in message && message.caption) {
      return message.caption;
    }

    return null;
  }

  /**
   * Проверяет, является ли сообщение ответом на сообщение бота
   * @param message Объект сообщения Telegram
   * @param botInfo Информация о боте
   * @returns true, если сообщение является ответом на сообщение бота
   */
  public isReplyToBot(message: any, botInfo: any): boolean {
    if (!message || !botInfo) return false;

    if (!("reply_to_message" in message) || !message.reply_to_message) {
      return false;
    }

    const replyMsg = message.reply_to_message;
    return (
      "from" in replyMsg && replyMsg.from && replyMsg.from.id === botInfo.id
    );
  }

  /**
   * Проверяет, упомянут ли бот в сообщении
   * @param messageText Текст сообщения
   * @param botUsername Имя пользователя бота
   * @returns true, если бот упомянут в сообщении
   */
  public isBotMentioned(messageText: string, botUsername: string): boolean {
    if (!messageText || !botUsername) return false;

    return messageText.includes(`@${botUsername}`);
  }

  /**
   * Проверяет, является ли сообщение постом из канала
   * @param message Объект сообщения Telegram
   * @returns true, если сообщение является постом из канала
   */
  public isChannelPost(message: any): boolean {
    if (!message) return false;

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

  /**
   * Очищает текст от упоминания бота
   * @param text Исходный текст сообщения
   * @param botUsername Имя пользователя бота
   * @returns Текст без упоминания бота
   */
  public cleanMentionFromText(text: string, botUsername?: string): string {
    if (!text) return "";

    // Если нет имени бота или оно не упомянуто, возвращаем текст без изменений
    if (!botUsername || !text.includes(`@${botUsername}`)) {
      return text;
    }

    // Убираем упоминание бота из текста
    return text.replace(`@${botUsername}`, "").trim();
  }

  /**
   * Проверяет, является ли сообщение командой
   * @param text Текст сообщения
   * @returns true, если сообщение является командой
   */
  public isCommand(text: string): boolean {
    if (!text) return false;

    return text.startsWith("/");
  }

  /**
   * Извлекает название команды из текста сообщения
   * @param text Текст сообщения
   * @returns Название команды или null, если это не команда
   */
  public extractCommand(text: string): string | null {
    if (!this.isCommand(text)) return null;

    // Извлекаем команду (все до первого пробела или до конца строки)
    const match = text.match(/^\/([a-zA-Z0-9_]+)/);
    return match ? match[1].toLowerCase() : null;
  }

  /**
   * Извлекает аргументы команды
   * @param text Текст сообщения с командой
   * @returns Строка с аргументами команды или пустая строка
   */
  public extractCommandArgs(text: string): string {
    if (!this.isCommand(text)) return "";

    // Удаляем команду и возвращаем остальную часть сообщения
    return text.replace(/^\/[a-zA-Z0-9_]+/, "").trim();
  }

  /**
   * Определяет, содержит ли сообщение вопрос
   * @param text Текст сообщения
   * @returns true, если сообщение содержит вопрос
   */
  public containsQuestion(text: string): boolean {
    if (!text) return false;

    // Проверяем наличие вопросительного знака
    if (text.includes("?")) return true;

    // Проверяем наличие вопросительных слов (кто, что, где, когда, как, почему)
    const questionWords = [
      /\bкто\b/i,
      /\bчто\b/i,
      /\bгде\b/i,
      /\bкогда\b/i,
      /\bкак\b/i,
      /\bпочему\b/i,
      /\bзачем\b/i,
      /\bкакой\b/i,
      /\bкакая\b/i,
      /\bкакое\b/i,
      /\bкакие\b/i,
      /\bсколько\b/i,
    ];

    return questionWords.some((regex) => regex.test(text));
  }

  /**
   * Проверяет, содержит ли сообщение приветствие
   * @param text Текст сообщения
   * @returns true, если сообщение содержит приветствие
   */
  public containsGreeting(text: string): boolean {
    if (!text) return false;

    const greetings = [
      /\bпривет\b/i,
      /\bздравствуй\b/i,
      /\bдобрый день\b/i,
      /\bдоброе утро\b/i,
      /\bдобрый вечер\b/i,
      /\bхай\b/i,
      /\bприветствую\b/i,
      /\bсалют\b/i,
      /\bхеллоу\b/i,
      /\bhi\b/i,
      /\bhello\b/i,
      /\bhey\b/i,
    ];

    return greetings.some((regex) => regex.test(text));
  }

  /**
   * Анализирует сложность текста по длине и структуре
   * @param text Текст для анализа
   * @returns Объект с информацией о сложности текста
   */
  public analyzeTextComplexity(text: string): {
    length: number;
    wordCount: number;
    sentenceCount: number;
    isComplex: boolean;
  } {
    if (!text) {
      return { length: 0, wordCount: 0, sentenceCount: 0, isComplex: false };
    }

    // Удаляем лишние пробелы
    const cleanText = text.trim().replace(/\s+/g, " ");

    // Подсчитываем количество слов
    const words = cleanText.split(" ");
    const wordCount = words.length;

    // Подсчитываем примерное количество предложений
    const sentences = cleanText.split(/[.!?]+/);
    const sentenceCount = sentences.filter((s) => s.trim().length > 0).length;

    // Определяем сложность текста
    // Текст считается сложным, если в нем много слов или предложений
    const isComplex = wordCount > 100 || sentenceCount > 5;

    return {
      length: cleanText.length,
      wordCount,
      sentenceCount,
      isComplex,
    };
  }
}
