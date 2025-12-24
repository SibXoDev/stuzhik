import { Show, For, createSignal, createEffect } from "solid-js";
import { useModProfiles } from "../../../shared/hooks";
import { useMods } from "../../mods/hooks/useMods";
import type { ModProfile } from "../../../shared/types";
import { createConfirmDialog } from "../../../shared/components/ConfirmDialog";
import { addToast } from "../../../shared/components/Toast";
import { invoke } from "@tauri-apps/api/core";
import { save, open } from "@tauri-apps/plugin-dialog";
import { writeTextFile, readTextFile } from "@tauri-apps/plugin-fs";

interface ModProfilesPanelProps {
  instanceId: string;
}

export function ModProfilesPanel(props: ModProfilesPanelProps) {
  const profiles = useModProfiles(() => props.instanceId);
  const mods = useMods(() => props.instanceId);
  const [profileName, setProfileName] = createSignal("");
  const [profileDescription, setProfileDescription] = createSignal("");
  const [saving, setSaving] = createSignal(false);
  const [applying, setApplying] = createSignal(false);
  const { confirm, ConfirmDialogComponent } = createConfirmDialog();

  createEffect(() => {
    if (props.instanceId) {
      profiles.loadProfiles();
      mods.loadMods();
    }
  });

  const handleSaveProfile = async () => {
    const name = profileName().trim();
    if (!name) {
      addToast({
        type: "error",
        title: "Ошибка",
        message: "Введите название профиля",
        duration: 3000,
      });
      return;
    }

    setSaving(true);
    try {
      const enabledModIds = mods.mods().filter((m) => m.enabled).map((m) => m.id);

      if (enabledModIds.length === 0) {
        const confirmed = await confirm({
          title: "Нет включённых модов",
          message: "Вы уверены, что хотите сохранить профиль без включённых модов?",
          variant: "warning",
          confirmText: "Сохранить",
        });

        if (!confirmed) {
          setSaving(false);
          return;
        }
      }

      const profileId = await profiles.saveProfile(
        name,
        profileDescription().trim() || null,
        enabledModIds
      );

      if (profileId) {
        setProfileName("");
        setProfileDescription("");
        addToast({
          type: "success",
          title: "Профиль сохранён",
          message: `"${name}" успешно создан`,
          duration: 3000,
        });
      }
    } finally {
      setSaving(false);
    }
  };

  const handleApplyProfile = async (profile: ModProfile) => {
    const confirmed = await confirm({
      title: "Применить профиль?",
      message: `Будут включены ${profile.enabled_mod_ids.length} модов, остальные будут отключены. Продолжить?`,
      variant: "warning",
      confirmText: "Применить",
    });

    if (!confirmed) return;

    setApplying(true);
    try {
      const success = await profiles.applyProfile(profile.id);
      if (success) {
        await mods.loadMods();
        addToast({
          type: "success",
          title: "Профиль применён",
          message: `"${profile.name}" успешно применён`,
          duration: 3000,
        });
      }
    } finally {
      setApplying(false);
    }
  };

  const handleDeleteProfile = async (profile: ModProfile) => {
    const confirmed = await confirm({
      title: "Удалить профиль?",
      message: `Профиль "${profile.name}" будет удалён. Это действие нельзя отменить.`,
      variant: "danger",
      confirmText: "Удалить",
    });

    if (!confirmed) return;

    const success = await profiles.deleteProfile(profile.id);
    if (success) {
      addToast({
        type: "success",
        title: "Профиль удалён",
        message: `"${profile.name}" успешно удалён`,
        duration: 3000,
      });
    }
  };

  const handleExportProfile = async (profile: ModProfile) => {
    try {
      const jsonData = await invoke<string>("export_mod_profile", {
        profileId: profile.id,
      });

      const filePath = await save({
        defaultPath: `${profile.name.replace(/[^a-zA-Z0-9-_]/g, "_")}.json`,
        filters: [{ name: "JSON Files", extensions: ["json"] }],
      });

      if (filePath) {
        await writeTextFile(filePath, jsonData);
        addToast({
          type: "success",
          title: "Профиль экспортирован",
          message: `"${profile.name}" сохранён в ${filePath}`,
          duration: 3000,
        });
      }
    } catch (err) {
      addToast({
        type: "error",
        title: "Ошибка экспорта",
        message: String(err),
        duration: 5000,
      });
    }
  };

  const handleImportProfile = async () => {
    try {
      const filePath = await open({
        multiple: false,
        filters: [{ name: "JSON Files", extensions: ["json"] }],
      });

      if (!filePath) return;

      const jsonData = await readTextFile(filePath as string);
      await invoke<string>("import_mod_profile", {
        instanceId: props.instanceId,
        jsonData,
      });

      await profiles.loadProfiles();

      addToast({
        type: "success",
        title: "Профиль импортирован",
        message: "Профиль успешно добавлен",
        duration: 3000,
      });
    } catch (err) {
      addToast({
        type: "error",
        title: "Ошибка импорта",
        message: String(err),
        duration: 5000,
      });
    }
  };

  const getProfileStats = (profile: ModProfile) => {
    const enabledCount = profile.enabled_mod_ids.length;
    const totalCount = mods.mods().length;
    const disabledCount = totalCount - enabledCount;

    return { enabledCount, totalCount, disabledCount };
  };

  const formatDate = (dateStr: string) => {
    try {
      return new Date(dateStr).toLocaleString("ru-RU", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return dateStr;
    }
  };

  return (
    <div class="flex h-full gap-4">
      {/* Left Panel - Create Profile */}
      <div class="w-96 flex flex-col gap-3 flex-shrink-0">
        <div class="card">
          <h3 class="text-lg font-semibold mb-4 flex items-center gap-2">
            <i class="i-hugeicons-add-circle w-5 h-5 text-blue-400" />
            Создать профиль
          </h3>

          <div class="flex flex-col gap-3">
            <div>
              <label class="block text-sm font-medium mb-1">Название</label>
              <input
                type="text"
                value={profileName()}
                onInput={(e) => setProfileName(e.currentTarget.value)}
                placeholder="Performance, Full, Streaming..."
                class="w-full"
                maxLength={50}
              />
            </div>

            <div>
              <label class="block text-sm font-medium mb-1">
                Описание <span class="text-gray-600">(опционально)</span>
              </label>
              <textarea
                value={profileDescription()}
                onInput={(e) => setProfileDescription(e.currentTarget.value)}
                placeholder="Описание профиля..."
                class="w-full"
                rows={3}
                maxLength={200}
              />
            </div>

            <div class="card bg-blue-600/10 border-blue-600/30 p-3">
              <div class="flex items-center gap-2 text-sm">
                <i class="i-hugeicons-information-circle w-4 h-4 text-blue-400" />
                <span class="text-blue-300">
                  Профиль сохранит текущее состояние модов ({mods.mods().filter((m) => m.enabled).length} включено)
                </span>
              </div>
            </div>

            <button
              class="btn-primary w-full"
              onClick={handleSaveProfile}
              disabled={!profileName().trim() || saving() || mods.loading()}
            >
              <Show when={saving()} fallback={
                <>
                  <i class="i-hugeicons-floppy-disk w-4 h-4" />
                  Сохранить профиль
                </>
              }>
                <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
                Сохранение...
              </Show>
            </button>
          </div>
        </div>

        {/* Quick Stats */}
        <div class="card">
          <h4 class="text-sm font-semibold mb-2">Текущее состояние</h4>
          <div class="flex gap-2">
            <div class="flex-1 p-2 rounded bg-green-600/20 border border-green-600/30">
              <div class="text-2xl font-bold text-green-400">
                {mods.mods().filter((m) => m.enabled).length}
              </div>
              <div class="text-xs text-green-300">Включено</div>
            </div>
            <div class="flex-1 p-2 rounded bg-gray-600/20 border border-gray-600/30">
              <div class="text-2xl font-bold text-gray-400">
                {mods.mods().filter((m) => !m.enabled).length}
              </div>
              <div class="text-xs text-gray-300">Выключено</div>
            </div>
          </div>
        </div>
      </div>

      {/* Right Panel - Profile List */}
      <div class="flex-1 flex flex-col gap-3 min-w-0">
        <div class="flex items-center justify-between">
          <h3 class="text-lg font-semibold flex items-center gap-2">
            <i class="i-hugeicons-layers-01 w-5 h-5 text-gray-500" />
            Сохранённые профили ({profiles.profiles().length})
          </h3>
          <button
            class="btn-secondary btn-sm"
            onClick={handleImportProfile}
            title="Импортировать профиль из файла"
          >
            <i class="i-hugeicons-upload-02 w-4 h-4" />
            Импорт
          </button>
        </div>

        {/* Loading */}
        <Show when={profiles.loading()}>
          <div class="card flex-center py-8">
            <i class="i-svg-spinners-6-dots-scale w-6 h-6" />
          </div>
        </Show>

        {/* Empty State */}
        <Show when={!profiles.loading() && profiles.profiles().length === 0}>
          <div class="card flex-1 flex-col-center text-center">
            <i class="i-hugeicons-layers-01 w-16 h-16 text-gray-600 mb-4" />
            <h3 class="text-lg font-semibold mb-2">Нет сохранённых профилей</h3>
            <p class="text-muted text-sm max-w-md">
              Создайте профиль, чтобы сохранить текущую конфигурацию модов и быстро переключаться между ними
            </p>
          </div>
        </Show>

        {/* Profiles Grid */}
        <Show when={!profiles.loading() && profiles.profiles().length > 0}>
          <div class="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <For each={profiles.profiles()}>
              {(profile) => {
                const stats = getProfileStats(profile);

                return (
                  <div class="card hover:border-blue-600/50 transition-colors">
                    <div class="flex items-start justify-between mb-3">
                      <div class="flex-1">
                        <h4 class="font-semibold text-lg">{profile.name}</h4>
                        <Show when={profile.description}>
                          <p class="text-sm text-muted mt-1">{profile.description}</p>
                        </Show>
                      </div>

                      <div class="flex gap-1">
                        <button
                          class="text-blue-400 hover:text-blue-300 p-1"
                          onClick={() => handleExportProfile(profile)}
                          title="Экспортировать профиль"
                        >
                          <i class="i-hugeicons-download-02 w-4 h-4" />
                        </button>
                        <button
                          class="text-red-400 hover:text-red-300 p-1"
                          onClick={() => handleDeleteProfile(profile)}
                          title="Удалить профиль"
                        >
                          <i class="i-hugeicons-delete-02 w-4 h-4" />
                        </button>
                      </div>
                    </div>

                    {/* Stats */}
                    <div class="flex gap-2 mb-3">
                      <div class="flex-1 p-2 rounded bg-gray-800">
                        <div class="text-sm font-medium text-green-400">{stats.enabledCount}</div>
                        <div class="text-xs text-gray-500">Включено</div>
                      </div>
                      <div class="flex-1 p-2 rounded bg-gray-800">
                        <div class="text-sm font-medium text-gray-400">{stats.disabledCount}</div>
                        <div class="text-xs text-gray-500">Выключено</div>
                      </div>
                    </div>

                    {/* Metadata */}
                    <div class="flex items-center justify-between text-xs text-muted mb-3">
                      <span>Создан: {formatDate(profile.created_at)}</span>
                    </div>

                    {/* Apply Button */}
                    <button
                      class="btn-primary w-full"
                      onClick={() => handleApplyProfile(profile)}
                      disabled={applying()}
                    >
                      <Show when={applying()} fallback={
                        <>
                          <i class="i-hugeicons-checkmark-circle-02 w-4 h-4" />
                          Применить профиль
                        </>
                      }>
                        <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
                        Применение...
                      </Show>
                    </button>
                  </div>
                );
              }}
            </For>
          </div>
        </Show>
      </div>

      <ConfirmDialogComponent />
    </div>
  );
}
