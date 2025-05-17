import axios, { AxiosError } from "axios";
import { BOT_DEFAULTS } from "../constants";
import { ChatMessage } from "../types";

export class ApiService {
  private apiKey: string;
  private botName: string;

  constructor(apiKey: string, botName: string) {
    this.apiKey = apiKey;
    this.botName = botName;
  }

  /**
   * Вызывает API с автоматическими повторами при ошибках сети
   * @param messages Сообщения для отправки в API
   * @param maxRetries Максимальное количество повторных попыток
   * @param timeout Таймаут для запроса в мс
   * @returns Строка с ответом от API
   */
  public async callApiWithRetry(
    messages: ChatMessage[],
    maxRetries: number = BOT_DEFAULTS.API.DEFAULT_RETRIES,
    timeout: number = BOT_DEFAULTS.API.DEFAULT_TIMEOUT_MS
  ): Promise<string> {
    let retryCount = 0;
    let lastError: Error | AxiosError = new Error("Unknown error"); // Инициализация переменной

    while (retryCount < maxRetries) {
      try {
        const response = await this.callDeepseekApi(messages, timeout);
        return response;
      } catch (error) {
        lastError = error as Error | AxiosError;

        // Проверяем, является ли ошибка сетевой
        if (this.isNetworkError(error)) {
          // Экспоненциальная задержка перед повторной попыткой
          const waitTime =
            BOT_DEFAULTS.API.BACKOFF_BASE_MS * Math.pow(2, retryCount);
          console.log(
            `[${this.botName}] Network error, retrying in ${waitTime}ms (${
              retryCount + 1
            }/${maxRetries})`
          );
          await this.delay(waitTime);
          retryCount++;
          continue;
        }

        // Если это не сетевая ошибка, пробрасываем дальше
        throw error;
      }
    }

    console.error(
      `[${this.botName}] Failed after ${maxRetries} retries:`,
      lastError
    );
    throw lastError;
  }

  /**
   * Определяет тему поста с использованием NLP-подхода
   * @param postText Текст поста
   * @returns Строка с темой поста
   */
  public async inferPostTopic(postText: string): Promise<string> {
    // Если пост слишком короткий, возвращаем общую тему
    if (postText.length < 10) {
      return "Общая тема";
    }

    try {
      // Используем LLM для определения темы
      const response = await this.callDeepseekApi(
        [
          {
            role: "system",
            content:
              "Определи основную тему текста в 3-7 словах. Ответь только темой, без дополнительных пояснений.",
          },
          { role: "user", content: postText.substring(0, 500) }, // Берем только первые 500 символов
        ],
        5000
      );

      let topic = response.trim();
      // Убираем лишние кавычки и точки
      topic = topic.replace(/["'.]+$|^["'.]+/g, "");

      return topic || "Общая тема";
    } catch (error) {
      console.error(`[${this.botName}] Error inferring topic:`, error);

      // Фолбэк на простой метод в случае ошибки
      const topicMatch = postText.match(/^(.{1,50})[.!?]|^(.{1,50})/);
      return topicMatch ? topicMatch[0] : "Общая тема";
    }
  }

  /**
   * Делает запрос к API Deepseek
   * @param messages Сообщения для API
   * @param timeout Таймаут в мс
   * @returns Строка с ответом от API
   */
  private async callDeepseekApi(
    messages: ChatMessage[],
    timeout: number
  ): Promise<string> {
    const response = await axios.post(
      "https://api.deepseek.com/chat/completions",
      {
        model: "deepseek-chat",
        messages: messages,
        max_tokens: 1000,
      },
      {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        timeout: timeout,
      }
    );

    return response.data.choices[0].message.content;
  }

  /**
   * Проверяет, является ли ошибка сетевой ошибкой
   * @param error Объект ошибки
   * @returns true, если ошибка сетевая
   */
  private isNetworkError(error: any): boolean {
    return (
      axios.isAxiosError(error) &&
      (error.code === "ECONNRESET" ||
        error.code === "ETIMEDOUT" ||
        error.code === "ECONNABORTED" ||
        error.message.includes("timeout") ||
        error.message.includes("network") ||
        !error.response)
    );
  }

  /**
   * Создает задержку выполнения
   * @param ms Время задержки в миллисекундах
   * @returns Promise, который разрешается после указанной задержки
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
