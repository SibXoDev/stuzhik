import { Show, createSignal } from "solid-js";
import { useI18n } from "../../../shared/i18n";
import { FileBrowserPanel } from "../../modpack-editor";
import { RecipeBuilder } from "./RecipeBuilder";
import { MetadataEditor } from "./MetadataEditor";

interface EditorPanelProps {
  instanceId: string;
}

export function EditorPanel(props: EditorPanelProps) {
  const { t } = useI18n();
  const [showRecipeBuilder, setShowRecipeBuilder] = createSignal(false);
  const [showMetadataEditor, setShowMetadataEditor] = createSignal(false);

  // Copy code to clipboard
  const copyToClipboard = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      // Fallback handled in RecipeBuilder
    }
  };

  return (
    <div class="h-full flex flex-col">
      {/* Toolbar */}
      <div class="flex items-center gap-2 px-4 py-2 border-b border-gray-750 bg-gray-850/50 flex-shrink-0">
        <span class="text-sm text-muted">{t().editor.visualTools}:</span>

        <button
          class="btn-ghost btn-sm flex items-center gap-1.5"
          onClick={() => setShowRecipeBuilder(true)}
        >
          <i class="i-hugeicons-grid w-4 h-4 text-green-400" />
          <span>{t().editor.recipeBuilder}</span>
        </button>

        <button
          class="btn-ghost btn-sm flex items-center gap-1.5"
          onClick={() => setShowMetadataEditor(true)}
        >
          <i class="i-hugeicons-package w-4 h-4 text-purple-400" />
          <span>{t().editor.metadataEditor}</span>
        </button>
      </div>

      {/* File Browser */}
      <div class="flex-1 min-h-0">
        <FileBrowserPanel instanceId={props.instanceId} />
      </div>

      {/* Recipe Builder Modal */}
      <Show when={showRecipeBuilder()}>
        <RecipeBuilder
          instanceId={props.instanceId}
          onClose={() => setShowRecipeBuilder(false)}
          onInsert={copyToClipboard}
          format="kubejs"
        />
      </Show>

      {/* Metadata Editor Modal */}
      <Show when={showMetadataEditor()}>
        <MetadataEditor
          instanceId={props.instanceId}
          onClose={() => setShowMetadataEditor(false)}
        />
      </Show>
    </div>
  );
}
