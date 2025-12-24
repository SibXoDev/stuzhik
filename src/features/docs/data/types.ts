import { JSX } from "solid-js";

/**
 * Ссылка на исходный код
 */
export interface CodeReference {
  /** Путь к файлу (относительно корня проекта) */
  path: string;
  /** Номер строки (1-indexed) */
  line?: number;
  /** Описание того, что находится в этом файле */
  description: string;
  /** Язык для подсветки (опционально) */
  language?: "rust" | "typescript" | "tsx" | "json" | "toml";
}

/**
 * Элемент контента документации
 */
/**
 * Ссылка на файл/папку в системе
 */
export interface FileLink {
  /** Путь относительно директории экземпляра или абсолютный */
  path: string;
  /** Описание файла/папки */
  description: string;
  /** Это папка? */
  isDirectory?: boolean;
}

export type DocContentItem =
  | { type: "paragraph"; text: string }
  | { type: "heading"; level: 2 | 3 | 4; text: string }
  | { type: "list"; ordered?: boolean; items: string[] }
  | { type: "code"; language: string; code: string; filename?: string }
  | { type: "codeRef"; refs: CodeReference[] }
  | { type: "fileLinks"; links: FileLink[] }
  | { type: "table"; headers: string[]; rows: string[][] }
  | { type: "tip"; variant: "info" | "warning" | "danger" | "success"; title: string; text: string }
  | { type: "keyboard"; shortcuts: { keys: string; description: string }[] }
  | { type: "cards"; cards: { icon: string; title: string; description: string; badge?: string; navigateTo?: { sectionId: string; subsectionId?: string } }[] }
  | { type: "steps"; steps: { title: string; description: string }[] }
  | { type: "divider" }
  | { type: "custom"; render: () => JSX.Element };

/**
 * Подсекция документации
 */
export interface DocSubsection {
  id: string;
  titleKey: string; // ключ локализации
  content: DocContentItem[];
}

/**
 * Секция документации
 */
export interface DocSection {
  id: string;
  titleKey: string; // ключ локализации
  icon: string;
  /** Для расширенного поиска */
  keywords?: string[];
  /** Подсекции (опционально) */
  subsections?: DocSubsection[];
  /** Контент секции (если нет подсекций) */
  content?: DocContentItem[];
}

/**
 * Результат поиска по документации
 */
export interface DocSearchResult {
  sectionId: string;
  subsectionId?: string;
  titleKey: string;
  /** Найденный текст с подсветкой */
  matchedText: string;
  /** Индекс релевантности */
  score: number;
}

/**
 * Состояние навигации документации
 */
export interface DocNavigationState {
  activeSectionId: string;
  activeSubsectionId?: string;
  expandedSections: Set<string>;
}

/**
 * Тип целевой аудитории для фильтрации контента
 */
export type AudienceLevel = "beginner" | "modpacker" | "developer";
