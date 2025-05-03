export interface BotConfig {
  BOT_TOKEN: string;
  DEEPSEEK_API_KEY: string;
  SYSTEM_PROMPT: string;
  POST_COMMENT_PROMPT_TEMPLATE: string;
  BOT_NAME: string;
  IGNORE_MESSAGES_OLDER_THAN_MINS?: number;
}

export interface Message {
  role: "user" | "assistant";
  content: string;
}

export interface UserContext {
  messages: Message[];
  lastInteraction: number;
  postTopic?: string;
}

// Добавляем тип для сигналов процесса
export type ProcessSignal = "SIGINT" | "SIGTERM" | "SIGKILL";
