import { For, Show } from "solid-js";

export interface OpenFile {
  path: string;
  name: string;
  isDirty: boolean;
  language: string;
}

interface FileTabsProps {
  files: OpenFile[];
  activeFile: string | null;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  onCloseOthers?: (path: string) => void;
  onCloseAll?: () => void;
}

export function FileTabs(props: FileTabsProps) {
  const getFileIcon = (name: string): string => {
    const ext = name.split(".").pop()?.toLowerCase();
    switch (ext) {
      case "json":
      case "json5":
      case "jsonc":
        return "i-hugeicons-code-square";
      case "toml":
        return "i-hugeicons-settings-02";
      case "yaml":
      case "yml":
        return "i-hugeicons-list-view";
      case "js":
      case "ts":
        return "i-hugeicons-java-script";
      case "properties":
      case "cfg":
      case "ini":
        return "i-hugeicons-settings-01";
      case "zs":
        return "i-hugeicons-code";
      case "mcfunction":
        return "i-hugeicons-command-line";
      default:
        return "i-hugeicons-file-01";
    }
  };

  const handleClose = (e: MouseEvent, path: string) => {
    e.stopPropagation();
    props.onClose(path);
  };

  const handleMiddleClick = (e: MouseEvent, path: string) => {
    if (e.button === 1) {
      e.preventDefault();
      props.onClose(path);
    }
  };

  return (
    <Show when={props.files.length > 0}>
      <div class="flex items-center border-b border-gray-750 bg-gray-850 overflow-x-auto flex-shrink-0">
        <For each={props.files}>
          {(file) => {
            const isActive = file.path === props.activeFile;

            return (
              <div
                role="button"
                tabIndex={0}
                class={`flex items-center gap-2 px-3 py-2 text-sm border-r border-gray-750 transition-colors group min-w-0 max-w-[200px] cursor-pointer ${
                  isActive
                    ? "bg-gray-800 text-white"
                    : "text-gray-400 hover:text-white hover:bg-gray-800/50"
                }`}
                onClick={() => props.onSelect(file.path)}
                onMouseDown={(e) => handleMiddleClick(e, file.path)}
                onKeyDown={(e) => e.key === "Enter" && props.onSelect(file.path)}
                title={file.path}
              >
                <i class={`${getFileIcon(file.name)} w-4 h-4 flex-shrink-0 ${isActive ? "text-blue-400" : "text-gray-500"}`} />
                <span class="truncate">{file.name}</span>
                <Show when={file.isDirty}>
                  <span class="w-2 h-2 rounded-full bg-yellow-400 flex-shrink-0" title="Не сохранено" />
                </Show>
                <button
                  class={`p-0.5 rounded hover:bg-gray-700 transition-colors flex-shrink-0 ${
                    isActive ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                  }`}
                  onClick={(e) => handleClose(e, file.path)}
                  title="Закрыть"
                >
                  <i class="i-hugeicons-cancel-01 w-3.5 h-3.5" />
                </button>
              </div>
            );
          }}
        </For>

        {/* Close All button */}
        <Show when={props.files.length > 1 && props.onCloseAll}>
          <button
            class="px-2 py-2 text-gray-500 hover:text-gray-300 transition-colors flex-shrink-0"
            onClick={props.onCloseAll}
            title="Закрыть все"
          >
            <i class="i-hugeicons-cancel-01 w-4 h-4" />
          </button>
        </Show>
      </div>
    </Show>
  );
}
