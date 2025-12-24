import type * as Monaco from "monaco-editor";
import type { MinecraftItem } from "../../types/code-editor/minecraft";

/**
 * Monaco CompletionProvider для автодополнения Minecraft предметов
 */
export class MinecraftItemsProvider implements Monaco.languages.CompletionItemProvider {
  private searchItems: (query: string, limit?: number) => Promise<MinecraftItem[]>;

  constructor(searchItems: (query: string, limit?: number) => Promise<MinecraftItem[]>) {
    this.searchItems = searchItems;
  }

  triggerCharacters = ['"', "'", ":"];

  async provideCompletionItems(
    model: Monaco.editor.ITextModel,
    position: Monaco.Position,
    _context: Monaco.languages.CompletionContext
  ): Promise<Monaco.languages.CompletionList | null> {
    const textUntilPosition = model.getValueInRange({
      startLineNumber: position.lineNumber,
      startColumn: 1,
      endLineNumber: position.lineNumber,
      endColumn: position.column,
    });

    // Проверяем находимся ли мы внутри строки
    const stringMatch = this.findStringContext(textUntilPosition, position.column);

    if (!stringMatch) {
      return null;
    }

    // Извлекаем текущее слово для поиска
    const query = stringMatch.text.trim();

    // Ищем предметы
    const items = await this.searchItems(query, 50);

    return {
      suggestions: items.map((item) => this.createCompletionItem(item, stringMatch)),
      incomplete: items.length >= 50, // Есть еще результаты
    };
  }

  private findStringContext(text: string, column: number): { text: string; start: number; end: number } | null {
    // Ищем открывающую кавычку
    let quoteChar: string | null = null;
    let startPos = -1;

    for (let i = column - 2; i >= 0; i--) {
      const char = text[i];
      if ((char === '"' || char === "'") && (i === 0 || text[i - 1] !== "\\")) {
        quoteChar = char;
        startPos = i;
        break;
      }
    }

    if (!quoteChar || startPos === -1) {
      return null;
    }

    // Извлекаем текст внутри кавычек
    const textInsideQuotes = text.substring(startPos + 1, column - 1);

    return {
      text: textInsideQuotes,
      start: startPos + 1,
      end: column - 1,
    };
  }

  private createCompletionItem(
    item: MinecraftItem,
    context: { text: string; start: number; end: number }
  ): Monaco.languages.CompletionItem {
    // Определяем тип completion item
    const kind = 6; // Monaco.languages.CompletionItemKind.Constant

    return {
      label: {
        label: item.id,
        description: item.name,
      },
      kind,
      insertText: item.id,
      detail: `${item.mod_id} • Stack: ${item.stack_size}`,
      documentation: {
        value: this.createDocumentation(item),
        isTrusted: true,
      },
      sortText: this.getSortText(item, context.text),
      filterText: `${item.id} ${item.name}`,
      range: {
        startLineNumber: 0,
        startColumn: context.start + 1,
        endLineNumber: 0,
        endColumn: context.end + 1,
      },
    };
  }

  private createDocumentation(item: MinecraftItem): string {
    const parts = [
      `**${item.name}**`,
      "",
      `ID: \`${item.id}\``,
      `Mod: ${item.mod_id}`,
      `Stack Size: ${item.stack_size}`,
      `Rarity: ${item.rarity}`,
    ];

    if (item.tags.length > 0) {
      parts.push("", `Tags: ${item.tags.map((t) => `\`${t}\``).join(", ")}`);
    }

    if (item.description) {
      parts.push("", item.description);
    }

    return parts.join("\n");
  }

  private getSortText(item: MinecraftItem, query: string): string {
    const lowerQuery = query.toLowerCase();
    const lowerId = item.id.toLowerCase();
    const lowerName = item.name.toLowerCase();

    // Exact match - highest priority
    if (lowerId === lowerQuery) return "0_" + item.id;

    // Starts with query
    if (lowerId.startsWith(lowerQuery)) return "1_" + item.id;
    if (lowerName.startsWith(lowerQuery)) return "2_" + item.id;

    // Contains query
    if (lowerId.includes(lowerQuery)) return "3_" + item.id;
    if (lowerName.includes(lowerQuery)) return "4_" + item.id;

    // Fallback
    return "5_" + item.id;
  }
}
