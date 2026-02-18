import { Component, For, Show, Switch, Match, createSignal, createEffect } from "solid-js";
import type { DocContentItem, CodeReference, FileLink } from "../data/types";
import { useI18n } from "../../../shared/i18n";
import { highlightCode } from "../../../shared/utils/highlighter";
import { invoke } from "@tauri-apps/api/core";

interface Props {
  items: DocContentItem[];
  onOpenSourceCode?: (path: string, line?: number) => void;
  onNavigate?: (sectionId: string, subsectionId?: string) => void;
}

/**
 * Получить локализованный текст или вернуть как есть если не найден
 */
function getLocalizedText(t: () => Record<string, unknown>, key: string | undefined): string {
  if (!key || typeof key !== "string") return "";

  // Пытаемся получить значение по пути (например "docs.sections.title")
  const parts = key.split(".");
  let current: unknown = t();

  for (const part of parts) {
    if (current && typeof current === "object" && part in current) {
      current = (current as Record<string, unknown>)[part];
    } else {
      // Ключ не найден, возвращаем как есть
      return key;
    }
  }

  return typeof current === "string" ? current : key;
}

// ============================================================================
// SUB-COMPONENTS
// ============================================================================

const CodeRefCard: Component<{
  codeRef: CodeReference;
  onOpen?: (path: string, line?: number) => void;
}> = (props) => {
  const { t } = useI18n();

  const getLanguageIcon = (lang?: string) => {
    switch (lang) {
      case "rust": return "i-hugeicons-code text-orange-400";
      case "typescript": case "tsx": return "i-hugeicons-java-script text-blue-400";
      case "json": return "i-hugeicons-code-square text-yellow-300";
      case "toml": return "i-hugeicons-settings-02 text-gray-400";
      default: return "i-hugeicons-file-01 text-gray-400";
    }
  };

  return (
    <button
      class="flex items-center gap-3 w-full p-3 rounded-xl bg-gray-800/50 hover:bg-gray-800 border border-gray-750 hover:border-[var(--color-primary-border)] transition-all text-left group"
      onClick={() => props.onOpen?.(props.codeRef.path, props.codeRef.line)}
    >
      <i class={`${getLanguageIcon(props.codeRef.language)} w-5 h-5 flex-shrink-0`} />
      <div class="flex-1 min-w-0">
        <div class="font-mono text-sm text-gray-300 truncate group-hover:text-[var(--color-primary)] transition-colors">
          {props.codeRef.path}
          <Show when={props.codeRef.line}>
            <span class="text-gray-500">:{props.codeRef.line}</span>
          </Show>
        </div>
        <div class="text-xs text-gray-500 truncate">
          {getLocalizedText(t, props.codeRef.description)}
        </div>
      </div>
      <i class="i-hugeicons-arrow-right-01 w-4 h-4 text-gray-600 group-hover:text-[var(--color-primary)] transition-colors flex-shrink-0" />
    </button>
  );
};

const FileLinkCard: Component<{
  link: FileLink;
}> = (props) => {
  const { t } = useI18n();

  const handleOpen = async () => {
    try {
      await invoke("open_app_folder", { folderType: props.link.path });
    } catch (e) {
      if (import.meta.env.DEV) console.error("Failed to open folder:", e);
    }
  };

  return (
    <button
      class="flex items-center gap-3 w-full p-3 rounded-xl bg-gray-800/50 hover:bg-gray-800 border border-gray-750 hover:border-green-500/50 transition-all text-left group"
      onClick={handleOpen}
    >
      <i class={`${props.link.isDirectory ? "i-hugeicons-folder-01 text-yellow-400" : "i-hugeicons-file-01 text-gray-400"} w-5 h-5 flex-shrink-0`} />
      <div class="flex-1 min-w-0">
        <div class="font-mono text-sm text-gray-300 truncate group-hover:text-green-400 transition-colors">
          {props.link.path}
        </div>
        <div class="text-xs text-gray-500 truncate">
          {getLocalizedText(t, props.link.description)}
        </div>
      </div>
      <i class="i-hugeicons-folder-open w-4 h-4 text-gray-600 group-hover:text-green-400 transition-colors flex-shrink-0" />
    </button>
  );
};

const TipBox: Component<{
  variant: "info" | "warning" | "danger" | "success";
  title: string;
  text: string;
}> = (props) => {
  const { t } = useI18n();

  const styles = {
    info: {
      bg: "bg-blue-500/10",
      border: "border-blue-500/30",
      icon: "i-hugeicons-information-circle text-blue-400",
      title: "text-blue-400",
    },
    warning: {
      bg: "bg-amber-500/10",
      border: "border-amber-500/30",
      icon: "i-hugeicons-alert-02 text-amber-400",
      title: "text-amber-400",
    },
    danger: {
      bg: "bg-red-500/10",
      border: "border-red-500/30",
      icon: "i-hugeicons-alert-circle text-red-400",
      title: "text-red-400",
    },
    success: {
      bg: "bg-green-500/10",
      border: "border-green-500/30",
      icon: "i-hugeicons-checkmark-circle-02 text-green-400",
      title: "text-green-400",
    },
  };

  const style = styles[props.variant];

  return (
    <div class={`${style.bg} border ${style.border} rounded-xl p-4`}>
      <div class="flex items-center gap-2 mb-2">
        <i class={`${style.icon} w-5 h-5`} />
        <h4 class={`font-medium ${style.title}`}>
          {getLocalizedText(t, props.title)}
        </h4>
      </div>
      <p class="text-sm text-gray-400 leading-relaxed">
        {getLocalizedText(t, props.text)}
      </p>
    </div>
  );
};

const KeyboardShortcuts: Component<{
  shortcuts: { keys: string; description: string }[];
}> = (props) => {
  const { t } = useI18n();

  return (
    <div class="bg-gray-900 rounded-xl overflow-hidden">
      <table class="w-full text-sm">
        <tbody class="text-gray-400">
          <For each={props.shortcuts}>
            {(shortcut, index) => (
              <tr class={index() < props.shortcuts.length - 1 ? "border-b border-gray-800" : ""}>
                <td class="py-3 px-4">
                  {getLocalizedText(t, shortcut.description)}
                </td>
                <td class="py-3 px-4 text-right">
                  <For each={shortcut.keys.split("+")}>
                    {(key, i) => (
                      <>
                        <kbd class="px-2 py-1 bg-gray-800 rounded text-xs font-mono">{key}</kbd>
                        <Show when={i() < shortcut.keys.split("+").length - 1}>
                          <span class="mx-1 text-gray-600">+</span>
                        </Show>
                      </>
                    )}
                  </For>
                </td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </div>
  );
};

const StepsComponent: Component<{
  steps: { title: string; description: string }[];
}> = (props) => {
  const { t } = useI18n();

  return (
    <div class="space-y-4">
      <For each={props.steps}>
        {(step, index) => (
          <div class="flex gap-4">
            <div class="flex-shrink-0 w-8 h-8 rounded-full bg-blue-600/20 border border-blue-500/30 flex items-center justify-center text-blue-400 font-bold text-sm">
              {index() + 1}
            </div>
            <div class="flex-1 pt-1">
              <h4 class="font-medium text-gray-200 mb-1">
                {getLocalizedText(t, step.title)}
              </h4>
              <p class="text-sm text-gray-400">
                {getLocalizedText(t, step.description)}
              </p>
            </div>
          </div>
        )}
      </For>
    </div>
  );
};

const CardsComponent: Component<{
  cards: { icon: string; title: string; description: string; badge?: string; navigateTo?: { sectionId: string; subsectionId?: string } }[];
  onNavigate?: (sectionId: string, subsectionId?: string) => void;
}> = (props) => {
  const { t } = useI18n();

  return (
    <div class="grid grid-cols-2 gap-4">
      <For each={props.cards}>
        {(card) => {
          const isClickable = () => !!card.navigateTo && !!props.onNavigate;
          const handleClick = () => {
            if (card.navigateTo && props.onNavigate) {
              props.onNavigate(card.navigateTo.sectionId, card.navigateTo.subsectionId);
            }
          };

          return (
            <div
              class={`card p-4 ${isClickable() ? "cursor-pointer hover:border-[var(--color-primary-border)] hover:bg-gray-800/50 transition-all" : ""}`}
              onClick={handleClick}
            >
              <div class="flex items-center gap-2 mb-2">
                <i class={`${card.icon} w-5 h-5 text-blue-400`} />
                <Show when={card.badge}>
                  <span class="px-2 py-0.5 text-xs rounded-full bg-blue-500/15 text-blue-400 border border-blue-500/30">
                    {card.badge}
                  </span>
                </Show>
                <Show when={isClickable()}>
                  <i class="i-hugeicons-arrow-right-01 w-4 h-4 text-gray-600 ml-auto" />
                </Show>
              </div>
              <h4 class="font-medium mb-1">
                {getLocalizedText(t, card.title)}
              </h4>
              <p class="text-sm text-gray-500">
                {getLocalizedText(t, card.description)}
              </p>
            </div>
          );
        }}
      </For>
    </div>
  );
};

const CodeBlock: Component<{
  code: string;
  language: string;
  filename?: string;
}> = (props) => {
  const [html, setHtml] = createSignal<string>("");

  // NOTE: Using sync wrapper to avoid SolidJS async effect issues
  createEffect(() => {
    highlightCode(props.code, props.language)
      .then((highlighted) => setHtml(highlighted))
      .catch(() => {
        // Fallback to plain text
        setHtml(`<pre class="shiki"><code>${props.code.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</code></pre>`);
      });
  });

  return (
    <div class="rounded-xl overflow-hidden bg-gray-900 border border-gray-800">
      <Show when={props.filename}>
        <div class="px-4 py-2 border-b border-gray-800 text-xs text-gray-500 font-mono">
          {props.filename}
        </div>
      </Show>
      <Show when={html()} fallback={
        <pre class="p-4 overflow-x-auto">
          <code class="text-sm font-mono text-gray-300">{props.code}</code>
        </pre>
      }>
        <div innerHTML={html()} />
      </Show>
    </div>
  );
};

// ============================================================================
// MAIN COMPONENT
// ============================================================================

const DocContent: Component<Props> = (props) => {
  const { t } = useI18n();

  return (
    <div class="space-y-6">
      <For each={props.items}>
        {(item) => (
          <Switch>
            <Match when={item.type === "paragraph"}>
              <p class="text-gray-400 leading-relaxed">
                {getLocalizedText(t, (item as { type: "paragraph"; text: string }).text)}
              </p>
            </Match>

            <Match when={item.type === "heading"}>
              {(() => {
                const heading = item as { type: "heading"; level: 2 | 3 | 4; text: string };
                const text = getLocalizedText(t, heading.text);
                switch (heading.level) {
                  case 2: return <h2 class="text-xl font-semibold mt-8 mb-4">{text}</h2>;
                  case 3: return <h3 class="text-lg font-medium mt-6 mb-3">{text}</h3>;
                  case 4: return <h4 class="font-medium mt-4 mb-2">{text}</h4>;
                }
              })()}
            </Match>

            <Match when={item.type === "list"}>
              {(() => {
                const list = item as { type: "list"; ordered?: boolean; items: string[] };
                const baseClass = "space-y-2 list-inside text-gray-400";
                const listItems = (
                  <For each={list.items}>
                    {(listItem) => <li>{getLocalizedText(t, listItem)}</li>}
                  </For>
                );
                return list.ordered ? (
                  <ol class={`${baseClass} list-decimal`}>{listItems}</ol>
                ) : (
                  <ul class={`${baseClass} list-disc`}>{listItems}</ul>
                );
              })()}
            </Match>

            <Match when={item.type === "code"}>
              {(() => {
                const codeItem = item as { type: "code"; language: string; code: string; filename?: string };
                return (
                  <CodeBlock
                    code={codeItem.code}
                    language={codeItem.language}
                    filename={codeItem.filename}
                  />
                );
              })()}
            </Match>

            <Match when={item.type === "codeRef"}>
              {(() => {
                const refs = (item as { type: "codeRef"; refs: CodeReference[] }).refs;
                return (
                  <div class="space-y-2">
                    <div class="flex items-center gap-2 text-sm text-gray-500 mb-3">
                      <i class="i-hugeicons-source-code w-4 h-4" />
                      <span>{getLocalizedText(t, "docs.sourceCode")}</span>
                    </div>
                    <For each={refs}>
                      {(codeRef) => (
                        <CodeRefCard codeRef={codeRef} onOpen={props.onOpenSourceCode} />
                      )}
                    </For>
                  </div>
                );
              })()}
            </Match>

            <Match when={item.type === "fileLinks"}>
              {(() => {
                const links = (item as { type: "fileLinks"; links: FileLink[] }).links;
                return (
                  <div class="space-y-2">
                    <div class="flex items-center gap-2 text-sm text-gray-500 mb-3">
                      <i class="i-hugeicons-folder-01 w-4 h-4" />
                      <span>{getLocalizedText(t, "docs.openFolder")}</span>
                    </div>
                    <For each={links}>
                      {(link) => <FileLinkCard link={link} />}
                    </For>
                  </div>
                );
              })()}
            </Match>

            <Match when={item.type === "table"}>
              {(() => {
                const tableItem = item as { type: "table"; headers: string[]; rows: string[][] };
                return (
                  <div class="bg-gray-900 rounded-xl overflow-hidden">
                    <table class="w-full text-sm">
                      <thead>
                        <tr class="text-gray-500 border-b border-gray-800">
                          <For each={tableItem.headers}>
                            {(header) => (
                              <th class="text-left py-3 px-4 font-medium">
                                {getLocalizedText(t, header)}
                              </th>
                            )}
                          </For>
                        </tr>
                      </thead>
                      <tbody class="text-gray-400">
                        <For each={tableItem.rows}>
                          {(row, rowIndex) => (
                            <tr class={rowIndex() < tableItem.rows.length - 1 ? "border-b border-gray-800" : ""}>
                              <For each={row}>
                                {(cell) => (
                                  <td class="py-3 px-4">
                                    {getLocalizedText(t, cell)}
                                  </td>
                                )}
                              </For>
                            </tr>
                          )}
                        </For>
                      </tbody>
                    </table>
                  </div>
                );
              })()}
            </Match>

            <Match when={item.type === "tip"}>
              {(() => {
                const tip = item as { type: "tip"; variant: "info" | "warning" | "danger" | "success"; title: string; text: string };
                return <TipBox variant={tip.variant} title={tip.title} text={tip.text} />;
              })()}
            </Match>

            <Match when={item.type === "keyboard"}>
              {(() => {
                const kbd = item as { type: "keyboard"; shortcuts: { keys: string; description: string }[] };
                return <KeyboardShortcuts shortcuts={kbd.shortcuts} />;
              })()}
            </Match>

            <Match when={item.type === "cards"}>
              {(() => {
                const cards = item as { type: "cards"; cards: { icon: string; title: string; description: string; badge?: string; navigateTo?: { sectionId: string; subsectionId?: string } }[] };
                return <CardsComponent cards={cards.cards} onNavigate={props.onNavigate} />;
              })()}
            </Match>

            <Match when={item.type === "steps"}>
              {(() => {
                const steps = item as { type: "steps"; steps: { title: string; description: string }[] };
                return <StepsComponent steps={steps.steps} />;
              })()}
            </Match>

            <Match when={item.type === "divider"}>
              <hr class="border-gray-800 my-8" />
            </Match>

            <Match when={item.type === "custom"}>
              {(item as { type: "custom"; render: () => Element }).render()}
            </Match>
          </Switch>
        )}
      </For>
    </div>
  );
};

export default DocContent;
