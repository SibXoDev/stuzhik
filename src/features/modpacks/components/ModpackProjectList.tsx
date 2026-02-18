import { createSignal, onMount, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { ModpackProject } from "../../../shared/types";
import { createConfirmDialog } from "../../../shared/components/ConfirmDialog";
import { LoaderIcon } from "../../../shared/components/LoaderSelector";
import { Select } from "../../../shared/ui/Select";
import { useI18n, getSafeLocale } from "../../../shared/i18n";

interface Props {
  onSelect: (project: ModpackProject) => void;
  onClose: () => void;
}

export default function ModpackProjectList(props: Props) {
  const { confirm, ConfirmDialogComponent } = createConfirmDialog();
  const { t, language } = useI18n();
  const [projects, setProjects] = createSignal<ModpackProject[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [showCreateForm, setShowCreateForm] = createSignal(false);
  const [deleting, setDeleting] = createSignal<string | null>(null);

  // Create form state
  const [newName, setNewName] = createSignal("");
  const [newMcVersion, setNewMcVersion] = createSignal("1.20.1");
  const [newLoader, setNewLoader] = createSignal("fabric");
  const [creating, setCreating] = createSignal(false);

  const loadProjects = async () => {
    try {
      setLoading(true);
      setError(null);
      const result = await invoke<ModpackProject[]>("list_modpack_projects");
      setProjects(result);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  onMount(() => {
    loadProjects();
  });

  const handleCreate = async () => {
    if (!newName().trim()) return;

    try {
      setCreating(true);
      const projectId = await invoke<string>("create_modpack_project", {
        name: newName().trim(),
        minecraftVersion: newMcVersion(),
        loader: newLoader(),
        loaderVersion: null,
      });

      // Reload and select the new project
      await loadProjects();
      const newProject = projects().find((p) => p.id === projectId);
      if (newProject) {
        props.onSelect(newProject);
      }

      setShowCreateForm(false);
      setNewName("");
    } catch (e) {
      setError(String(e));
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (projectId: string, e: Event) => {
    e.stopPropagation();

    const confirmed = await confirm({
      title: "Удалить проект?",
      message: "Удалить этот проект модпака? Это действие нельзя отменить.",
      variant: "danger",
      confirmText: "Удалить",
    });
    if (!confirmed) return;

    try {
      setDeleting(projectId);
      await invoke("delete_modpack_project", { projectId });
      await loadProjects();
    } catch (e) {
      setError(String(e));
    } finally {
      setDeleting(null);
    }
  };

  const getLoaderColor = (loader: string) => {
    switch (loader) {
      case "fabric":
        return "text-amber-400";
      case "forge":
        return "text-orange-400";
      case "neoforge":
        return "text-red-400";
      case "quilt":
        return "text-purple-400";
      default:
        return "text-gray-400";
    }
  };

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString(getSafeLocale(language()), {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  };

  return (
    <div class="flex flex-col h-full max-h-[calc(100vh-8rem)]">
      {/* Header */}
      <div class="flex items-center justify-between p-4 border-b border-gray-750 flex-shrink-0">
        <div class="flex flex-col gap-1">
          <h2 class="text-xl font-bold text-white">Редактор модпаков</h2>
          <p class="text-sm text-gray-400">
            Создавайте и редактируйте собственные модпаки
          </p>
        </div>
        <div class="flex items-center gap-2">
          <button
            class="btn-primary"
            onClick={() => setShowCreateForm(true)}
          >
            <div class="i-hugeicons-add-01 w-4 h-4" />
            Новый проект
          </button>
          <button
            class="btn-close"
            onClick={props.onClose}
            aria-label={t().ui?.tooltips?.close ?? "Close"}
          >
            <i class="i-hugeicons-cancel-01 w-5 h-5" />
          </button>
        </div>
      </div>

      {/* Content */}
      <div class="flex-1 overflow-y-auto p-4 flex flex-col gap-4">

      {/* Create Form */}
      <Show when={showCreateForm()}>
        <div class="card p-4 border-2 border-[var(--color-primary-border)] bg-[var(--color-primary-bg)] flex flex-col gap-4">
          <h3 class="font-medium">Новый проект модпака</h3>

          <div class="grid grid-cols-2 gap-4">
            <div class="flex flex-col gap-1">
              <label class="block text-sm text-gray-400">Название</label>
              <input
                type="text"
                class="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-2xl text-gray-200 focus:border-[var(--color-primary)] focus:outline-none"
                placeholder="Мой модпак"
                value={newName()}
                onInput={(e) => setNewName(e.currentTarget.value)}
                autofocus
              />
            </div>

            <div class="flex flex-col gap-1">
              <label class="block text-sm text-gray-400">
                Версия Minecraft
              </label>
              <input
                type="text"
                class="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-2xl text-gray-200 focus:border-[var(--color-primary)] focus:outline-none"
                placeholder="1.20.1"
                value={newMcVersion()}
                onInput={(e) => setNewMcVersion(e.currentTarget.value)}
              />
            </div>

            <div class="flex flex-col gap-1">
              <label class="block text-sm text-gray-400">Загрузчик</label>
              <Select
                value={newLoader()}
                onChange={setNewLoader}
                options={[
                  { value: "fabric", label: "Fabric" },
                  { value: "forge", label: "Forge" },
                  { value: "neoforge", label: "NeoForge" },
                  { value: "quilt", label: "Quilt" },
                ]}
              />
            </div>
          </div>

          <div class="flex justify-end gap-2">
            <button
              class="btn-ghost"
              onClick={() => setShowCreateForm(false)}
            >
              Отмена
            </button>
            <button
              class="btn-primary"
              onClick={handleCreate}
              disabled={!newName().trim() || creating()}
            >
              {creating() ? (
                <>
                  <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
                  Создание...
                </>
              ) : (
                "Создать"
              )}
            </button>
          </div>
        </div>
      </Show>

      {/* Error */}
      <Show when={error()}>
        <div class="card p-3 bg-red-500/10 border-red-500/30">
          <div class="flex items-center gap-2 text-red-400">
            <div class="i-hugeicons-alert-02 w-5 h-5" />
            <span>{error()}</span>
          </div>
        </div>
      </Show>

      {/* Loading */}
      <Show when={loading()}>
        <div class="flex-1 flex items-center justify-center">
          <i class="i-svg-spinners-6-dots-scale w-8 h-8 text-[var(--color-primary)]" />
        </div>
      </Show>

      {/* Empty State */}
      <Show when={!loading() && projects().length === 0}>
        <div class="flex-1 flex flex-col items-center justify-center text-gray-400 gap-4">
          <div class="i-hugeicons-file-02 w-16 h-16 opacity-50" />
          <div class="flex flex-col items-center gap-2">
            <p class="text-lg">Нет проектов модпаков</p>
            <p class="text-sm">
              Создайте свой первый модпак, нажав кнопку выше
            </p>
          </div>
          <button
            class="btn-primary"
            onClick={() => setShowCreateForm(true)}
          >
            <div class="i-hugeicons-add-01 w-4 h-4" />
            Создать проект
          </button>
        </div>
      </Show>

      {/* Projects Grid */}
      <Show when={!loading() && projects().length > 0}>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4 overflow-y-auto flex-1">
          <For each={projects()}>
            {(project) => (
              <div
                class="card card-hover cursor-pointer group"
                onClick={() => props.onSelect(project)}
              >
                <div class="flex items-start gap-4">
                  {/* Icon */}
                  <div class="w-16 h-16 rounded-2xl bg-gray-800 flex items-center justify-center flex-shrink-0">
                    <LoaderIcon loader={project.loader} class="w-8 h-8" />
                  </div>

                  {/* Info */}
                  <div class="flex-1 min-w-0 flex flex-col gap-1">
                    <div class="flex items-center gap-2">
                      <h3 class="font-medium text-white truncate">
                        {project.name}
                      </h3>
                      <span class="text-xs text-gray-500">
                        v{project.version}
                      </span>
                    </div>

                    <div class="flex items-center gap-3 text-sm text-gray-400">
                      <span class="flex items-center gap-1">
                        <div class="i-hugeicons-game-controller-03 w-4 h-4" />
                        {project.minecraft_version}
                      </span>
                      <span class={`flex items-center gap-1 ${getLoaderColor(project.loader)}`}>
                        <LoaderIcon loader={project.loader} class="w-4 h-4" />
                        {project.loader}
                      </span>
                    </div>

                    <div class="flex items-center gap-4 text-xs text-gray-500">
                      <span class="flex items-center gap-1">
                        <div class="i-hugeicons-package w-3 h-3" />
                        {project.mods_count} модов
                      </span>
                      <span>Обновлён {formatDate(project.updated_at)}</span>
                    </div>
                  </div>

                  {/* Delete button */}
                  <button
                    class="absolute top-2 right-2 p-1.5 rounded opacity-0 group-hover:opacity-100 hover:bg-red-500/20 text-gray-400 hover:text-red-400 transition-all duration-100"
                    onClick={(e) => handleDelete(project.id, e)}
                    title="Удалить проект"
                  >
                    {deleting() === project.id ? (
                      <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
                    ) : (
                      <div class="i-hugeicons-delete-02 w-4 h-4" />
                    )}
                  </button>
                </div>

                {/* Description */}
                <Show when={project.description}>
                  <p class="mt-3 text-sm text-gray-400 line-clamp-2">
                    {project.description}
                  </p>
                </Show>
              </div>
            )}
          </For>
        </div>
      </Show>
      </div>

      {/* Confirm Dialog */}
      <ConfirmDialogComponent />
    </div>
  );
}
