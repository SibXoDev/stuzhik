import type * as Monaco from "monaco-editor";
import type { MinecraftItem } from "../../types/code-editor/minecraft";

/**
 * Monaco HoverProvider для показа информации о Minecraft предметах
 */
export class MinecraftItemsHoverProvider implements Monaco.languages.HoverProvider {
  private searchItems: (query: string, limit?: number) => Promise<MinecraftItem[]>;

  constructor(searchItems: (query: string, limit?: number) => Promise<MinecraftItem[]>) {
    this.searchItems = searchItems;
  }

  async provideHover(
    model: Monaco.editor.ITextModel,
    position: Monaco.Position
  ): Promise<Monaco.languages.Hover | null> {
    const word = model.getWordAtPosition(position);
    if (!word) return null;

    // Получаем полный текст строки
    const lineContent = model.getLineContent(position.lineNumber);

    // Проверяем находимся ли внутри строки
    const stringMatch = this.extractStringAtPosition(lineContent, position.column);
    if (!stringMatch) return null;

    // Ищем предмет по ID
    const items = await this.searchItems(stringMatch.text, 5);

    // Находим точное совпадение
    const exactMatch = items.find((item) => item.id === stringMatch.text);
    if (!exactMatch) return null;

    return {
      contents: [
        {
          value: this.createHoverContent(exactMatch),
          isTrusted: true,
        },
      ],
      range: {
        startLineNumber: position.lineNumber,
        startColumn: stringMatch.start + 1,
        endLineNumber: position.lineNumber,
        endColumn: stringMatch.end + 1,
      },
    };
  }

  private extractStringAtPosition(
    line: string,
    column: number
  ): { text: string; start: number; end: number } | null {
    let quoteStart = -1;
    let quoteEnd = -1;
    let quoteChar: string | null = null;

    // Поиск назад для начала строки
    for (let i = column - 1; i >= 0; i--) {
      const char = line[i];
      if ((char === '"' || char === "'") && (i === 0 || line[i - 1] !== "\\")) {
        quoteStart = i;
        quoteChar = char;
        break;
      }
    }

    if (quoteStart === -1 || !quoteChar) return null;

    // Поиск вперед для конца строки
    for (let i = column; i < line.length; i++) {
      const char = line[i];
      if (char === quoteChar && (i === 0 || line[i - 1] !== "\\")) {
        quoteEnd = i;
        break;
      }
    }

    if (quoteEnd === -1) {
      // Строка не закрыта - берем до конца строки
      quoteEnd = line.length;
    }

    const text = line.substring(quoteStart + 1, quoteEnd);

    return {
      text,
      start: quoteStart,
      end: quoteEnd,
    };
  }

  private createHoverContent(item: MinecraftItem): string {
    const parts = [
      `### ${item.name}`,
      "",
      "```",
      item.id,
      "```",
      "",
      `**Mod:** ${item.mod_id}`,
      `**Stack Size:** ${item.stack_size}`,
      `**Rarity:** ${item.rarity}`,
    ];

    if (item.tags.length > 0) {
      parts.push("", "**Tags:**");
      item.tags.forEach((tag) => {
        parts.push(`- \`${tag}\``);
      });
    }

    if (item.description) {
      parts.push("", "---", "", item.description);
    }

    return parts.join("\n");
  }
}
