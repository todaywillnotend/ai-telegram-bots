export interface BotConfig {
  BOT_TOKEN: string;
  BOT_NAME: string;
  DEEPSEEK_API_KEY: string;
  SYSTEM_PROMPT: string;
  POST_COMMENT_PROMPT_TEMPLATE: string;
  IGNORE_MESSAGES_OLDER_THAN_MINS?: number;
}

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface UserContext {
  messages: ChatMessage[];
  lastInteraction: number;
  postTopic?: string;
  messageCount: number; // Счетчик сообщений для периодической "настройки"
  activeConversation: boolean; // Флаг активного разговора
}

// Добавляем тип для сигналов процесса
export type ProcessSignal = "SIGINT" | "SIGTERM" | "SIGKILL";
