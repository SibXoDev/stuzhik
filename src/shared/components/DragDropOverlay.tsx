import { Show, For } from "solid-js";
import { useDragDrop } from "../stores/dragDrop";

export function DragDropOverlay() {
  const { isDragging, draggedFiles } = useDragDrop();

  return (
    <Show when={isDragging()}>
      <div class="fixed inset-0 z-[9999] pointer-events-none flex items-center justify-center bg-black/60 backdrop-blur-sm">
        <div class="bg-gray-800 border-2 border-dashed border-blue-500 rounded-2xl p-8 max-w-md shadow-2xl">
          <div class="flex flex-col items-center gap-4">
            {/* Icon */}
            <div class="w-16 h-16 rounded-full bg-blue-600/20 flex items-center justify-center">
              <i class="i-hugeicons-upload-02 w-8 h-8 text-blue-400" />
            </div>

            {/* Title */}
            <h3 class="text-xl font-semibold text-white">
              Перетащите файлы
            </h3>

            {/* File list */}
            <div class="w-full max-h-48 overflow-y-auto">
              <For each={draggedFiles()}>
                {(file) => (
                  <div class="flex items-center gap-2 py-2 px-3 bg-gray-700/50 rounded-lg mb-2">
                    <i
                      class={`w-5 h-5 text-gray-400 ${
                        file.extension === "jar"
                          ? "i-hugeicons-package"
                          : file.extension === "zip"
                          ? "i-hugeicons-folder-01"
                          : "i-hugeicons-file-01"
                      }`}
                    />
                    <span class="text-sm text-gray-300 truncate flex-1">
                      {file.name}
                    </span>
                    <span class="text-xs text-gray-500 uppercase">
                      {file.extension}
                    </span>
                  </div>
                )}
              </For>
            </div>

            {/* Hint */}
            <p class="text-sm text-gray-400 text-center">
              Отпустите для установки
            </p>
          </div>
        </div>
      </div>
    </Show>
  );
}
