import { BOT_DEFAULTS } from "../constants";
import { UserContext } from "../types";

/**
 * Класс для управления контекстами пользователей и постов
 * Отвечает за создание, получение и очистку контекстов
 */
export class ContextManager {
  private userContexts: Map<string, UserContext>;
  private postContexts: Map<string, UserContext>;
  private botName: string;

  constructor(botName: string) {
    this.userContexts = new Map<string, UserContext>();
    this.postContexts = new Map<string, UserContext>();
    this.botName = botName;

    // Запускаем периодическую очистку старых контекстов
    this.setupCleanupInterval();
  }

  /**
   * Получает контекст пользователя по ключу или создает новый
   * @param userKey Уникальный ключ пользователя
   * @returns Контекст пользователя
   */
  public getUserContext(userKey: string): UserContext {
    // Получаем существующий контекст или создаем новый
    if (!this.userContexts.has(userKey)) {
      this.userContexts.set(userKey, this.createNewUserContext());
    }

    const context = this.userContexts.get(userKey)!;
    return context;
  }

  /**
   * Получает контекст поста по ключу или создает новый
   * @param postKey Уникальный ключ поста
   * @param postTopic Опциональная тема поста
   * @returns Контекст поста
   */
  public getPostContext(postKey: string, postTopic?: string): UserContext {
    // Получаем существующий контекст или создаем новый
    if (!this.postContexts.has(postKey)) {
      this.postContexts.set(postKey, this.createNewUserContext(postTopic));
    } else if (postTopic) {
      // Обновляем тему, если она предоставлена
      const context = this.postContexts.get(postKey)!;
      context.postTopic = postTopic;
      context.lastInteraction = Date.now();
    }

    return this.postContexts.get(postKey)!;
  }

  /**
   * Обновляет время последнего взаимодействия для контекста
   * @param context Контекст для обновления
   */
  public updateLastInteraction(context: UserContext): void {
    context.lastInteraction = Date.now();
  }

  /**
   * Очищает старые контексты с динамическим TTL
   */
  public cleanupOldContexts(): void {
    const now = Date.now();

    // Очистка пользовательских контекстов
    this.cleanMapWithTtl(this.userContexts, now);

    // Очистка контекстов постов
    this.cleanMapWithTtl(this.postContexts, now);

    // Логируем статистику после очистки
    this.logCleanupStats();
  }

  /**
   * Возвращает количество активных контекстов
   * @returns Объект с количеством пользовательских и пост-контекстов
   */
  public getActiveContextsCount(): { users: number; posts: number } {
    return {
      users: this.userContexts.size,
      posts: this.postContexts.size,
    };
  }

  /**
   * Настраивает интервал для периодической очистки старых контекстов
   */
  private setupCleanupInterval(): void {
    setInterval(() => {
      this.cleanupOldContexts();
    }, BOT_DEFAULTS.CONTEXT.CLEANUP_INTERVAL_MS);

    console.log(
      `[${this.botName}] Context cleanup scheduled every ${
        BOT_DEFAULTS.CONTEXT.CLEANUP_INTERVAL_MS / 60000
      } minutes`
    );
  }

  /**
   * Создает новый контекст пользователя
   * @param postTopic Опциональная тема поста
   * @returns Новый контекст пользователя
   */
  private createNewUserContext(postTopic?: string): UserContext {
    return {
      messages: [],
      lastInteraction: Date.now(),
      postTopic: postTopic,
      messageCount: 0,
      activeConversation: false,
    };
  }

  /**
   * Очищает старые записи из указанной Map на основе TTL
   * @param contextMap Map с контекстами
   * @param currentTime Текущее время
   */
  private cleanMapWithTtl(
    contextMap: Map<string, UserContext>,
    currentTime: number
  ): void {
    for (const [key, context] of contextMap.entries()) {
      const ttl = context.activeConversation
        ? BOT_DEFAULTS.CONTEXT.ACTIVE_TTL_MS
        : BOT_DEFAULTS.CONTEXT.BASE_TTL_MS;

      if (currentTime - context.lastInteraction > ttl) {
        contextMap.delete(key);
      }
    }
  }

  /**
   * Логирует статистику активных контекстов
   */
  private logCleanupStats(): void {
    console.log(
      `[${this.botName}] Active contexts: ${this.userContexts.size} users, ${this.postContexts.size} posts`
    );
  }
}
