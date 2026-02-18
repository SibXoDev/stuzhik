import { Show, For, createSignal, createEffect } from "solid-js";
import { useModProfiles } from "../../../shared/hooks";
import { useMods } from "../../mods/hooks/useMods";
import type { ModProfile } from "../../../shared/types";
import { createConfirmDialog } from "../../../shared/components/ConfirmDialog";
import { addToast } from "../../../shared/components/Toast";
import { invoke } from "@tauri-apps/api/core";
import { save, open } from "@tauri-apps/plugin-dialog";
import { writeTextFile, readTextFile } from "@tauri-apps/plugin-fs";
import { useI18n } from "../../../shared/i18n";
import { Tooltip } from "../../../shared/ui";

interface ModProfilesPanelProps {
  instanceId: string;
}

export function ModProfilesPanel(props: ModProfilesPanelProps) {
  const { t } = useI18n();
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
        title: t().editor?.modProfiles?.toast?.error || "Error",
        message: t().editor?.modProfiles?.toast?.enterName || "Enter profile name",
        duration: 3000,
      });
      return;
    }

    setSaving(true);
    try {
      const enabledModIds = mods.mods().filter((m) => m.enabled).map((m) => m.id);

      if (enabledModIds.length === 0) {
        const confirmed = await confirm({
          title: t().editor?.modProfiles?.confirm?.noEnabledMods || "No enabled mods",
          message: t().editor?.modProfiles?.confirm?.noEnabledModsMessage || "Are you sure you want to save a profile without enabled mods?",
          variant: "warning",
          confirmText: t().editor?.modProfiles?.confirm?.save || "Save",
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
          title: t().editor?.modProfiles?.toast?.profileSaved || "Profile saved",
          message: (t().editor?.modProfiles?.toast?.profileSavedMessage || "\"{name}\" successfully created").replace("{name}", name),
          duration: 3000,
        });
      }
    } finally {
      setSaving(false);
    }
  };

  const handleApplyProfile = async (profile: ModProfile) => {
    const confirmed = await confirm({
      title: t().editor?.modProfiles?.confirm?.applyProfile || "Apply profile?",
      message: (t().editor?.modProfiles?.confirm?.applyProfileMessage || "{count} mods will be enabled, the rest will be disabled. Continue?").replace("{count}", String(profile.enabled_mod_ids.length)),
      variant: "warning",
      confirmText: t().editor?.modProfiles?.confirm?.apply || "Apply",
    });

    if (!confirmed) return;

    setApplying(true);
    try {
      const success = await profiles.applyProfile(profile.id);
      if (success) {
        await mods.loadMods();
        addToast({
          type: "success",
          title: t().editor?.modProfiles?.toast?.profileApplied || "Profile applied",
          message: (t().editor?.modProfiles?.toast?.profileAppliedMessage || "\"{name}\" successfully applied").replace("{name}", profile.name),
          duration: 3000,
        });
      }
    } finally {
      setApplying(false);
    }
  };

  const handleDeleteProfile = async (profile: ModProfile) => {
    const confirmed = await confirm({
      title: t().editor?.modProfiles?.confirm?.deleteProfile || "Delete profile?",
      message: (t().editor?.modProfiles?.confirm?.deleteProfileMessage || "Profile \"{name}\" will be deleted. This action cannot be undone.").replace("{name}", profile.name),
      variant: "danger",
      confirmText: t().editor?.modProfiles?.confirm?.delete || "Delete",
    });

    if (!confirmed) return;

    const success = await profiles.deleteProfile(profile.id);
    if (success) {
      addToast({
        type: "success",
        title: t().editor?.modProfiles?.toast?.profileDeleted || "Profile deleted",
        message: (t().editor?.modProfiles?.toast?.profileDeletedMessage || "\"{name}\" successfully deleted").replace("{name}", profile.name),
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
          title: t().editor?.modProfiles?.toast?.profileExported || "Profile exported",
          message: (t().editor?.modProfiles?.toast?.profileExportedMessage || "\"{name}\" saved to {path}").replace("{name}", profile.name).replace("{path}", filePath),
          duration: 3000,
        });
      }
    } catch (err) {
      addToast({
        type: "error",
        title: t().editor?.modProfiles?.toast?.exportError || "Export error",
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
        title: t().editor?.modProfiles?.toast?.profileImported || "Profile imported",
        message: t().editor?.modProfiles?.toast?.profileImportedMessage || "Profile successfully added",
        duration: 3000,
      });
    } catch (err) {
      addToast({
        type: "error",
        title: t().editor?.modProfiles?.toast?.importError || "Import error",
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
        <div class="card flex flex-col gap-4">
          <h3 class="text-lg font-semibold flex items-center gap-2">
            <i class="i-hugeicons-add-circle w-5 h-5 text-[var(--color-primary)]" />
            {t().editor?.modProfiles?.title || "Create Profile"}
          </h3>

          <div class="flex flex-col gap-3">
            <div>
              <label class="block text-sm font-medium mb-1">{t().editor?.modProfiles?.name || "Name"}</label>
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
                {t().editor?.modProfiles?.description || "Description"} <span class="text-gray-600">{t().editor?.modProfiles?.descriptionOptional || "(optional)"}</span>
              </label>
              <textarea
                value={profileDescription()}
                onInput={(e) => setProfileDescription(e.currentTarget.value)}
                placeholder={t().editor?.modProfiles?.descriptionPlaceholder || "Profile description..."}
                class="w-full"
                rows={3}
                maxLength={200}
              />
            </div>

            <div class="card bg-blue-600/10 border-blue-600/30 p-3">
              <div class="flex items-center gap-2 text-sm">
                <i class="i-hugeicons-information-circle w-4 h-4 text-blue-400" />
                <span class="text-blue-300">
                  {(t().editor?.modProfiles?.currentStateInfo || "Profile will save current mod state ({count} enabled)").replace("{count}", String(mods.mods().filter((m) => m.enabled).length))}
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
                  {t().editor?.modProfiles?.saveProfile || "Save Profile"}
                </>
              }>
                <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
                {t().editor?.modProfiles?.saving || "Saving..."}
              </Show>
            </button>
          </div>
        </div>

        {/* Quick Stats */}
        <div class="card">
          <h4 class="text-sm font-semibold mb-2">{t().editor?.modProfiles?.currentState || "Current State"}</h4>
          <div class="flex gap-2">
            <div class="flex-1 p-2 rounded bg-green-600/20 border border-green-600/30">
              <div class="text-2xl font-bold text-green-400">
                {mods.mods().filter((m) => m.enabled).length}
              </div>
              <div class="text-xs text-green-300">{t().editor?.modProfiles?.enabled || "Enabled"}</div>
            </div>
            <div class="flex-1 p-2 rounded bg-gray-600/20 border border-gray-600/30">
              <div class="text-2xl font-bold text-gray-400">
                {mods.mods().filter((m) => !m.enabled).length}
              </div>
              <div class="text-xs text-gray-300">{t().editor?.modProfiles?.disabled || "Disabled"}</div>
            </div>
          </div>
        </div>
      </div>

      {/* Right Panel - Profile List */}
      <div class="flex-1 flex flex-col gap-3 min-w-0">
        <div class="flex items-center justify-between">
          <h3 class="text-lg font-semibold flex items-center gap-2">
            <i class="i-hugeicons-layers-01 w-5 h-5 text-gray-500" />
            {t().editor?.modProfiles?.savedProfiles || "Saved Profiles"} ({profiles.profiles().length})
          </h3>
          <Tooltip text={t().editor?.modProfiles?.importTitle || "Import profile from file"} position="bottom">
            <button
              class="btn-secondary btn-sm"
              onClick={handleImportProfile}
            >
              <i class="i-hugeicons-upload-02 w-4 h-4" />
              {t().editor?.modProfiles?.import || "Import"}
            </button>
          </Tooltip>
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
            <h3 class="text-lg font-semibold mb-2">{t().editor?.modProfiles?.noProfiles || "No saved profiles"}</h3>
            <p class="text-muted text-sm max-w-md">
              {t().editor?.modProfiles?.noProfilesHint || "Create a profile to save current mod configuration and quickly switch between them"}
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
                  <div class="card hover:border-[var(--color-primary-border)] transition-colors">
                    <div class="flex items-start justify-between mb-3">
                      <div class="flex-1">
                        <h4 class="font-semibold text-lg">{profile.name}</h4>
                        <Show when={profile.description}>
                          <p class="text-sm text-muted mt-1">{profile.description}</p>
                        </Show>
                      </div>

                      <div class="flex gap-1">
                        <Tooltip text={t().editor?.modProfiles?.exportTitle || "Export profile"} position="bottom">
                          <button
                            class="text-[var(--color-primary)] hover:text-[var(--color-primary-light)] p-1"
                            onClick={() => handleExportProfile(profile)}
                          >
                            <i class="i-hugeicons-download-02 w-4 h-4" />
                          </button>
                        </Tooltip>
                        <Tooltip text={t().editor?.modProfiles?.deleteTitle || "Delete profile"} position="bottom">
                          <button
                            class="text-red-400 hover:text-red-300 p-1"
                            onClick={() => handleDeleteProfile(profile)}
                          >
                            <i class="i-hugeicons-delete-02 w-4 h-4" />
                          </button>
                        </Tooltip>
                      </div>
                    </div>

                    {/* Stats */}
                    <div class="flex gap-2 mb-3">
                      <div class="flex-1 p-2 rounded bg-gray-800">
                        <div class="text-sm font-medium text-green-400">{stats.enabledCount}</div>
                        <div class="text-xs text-gray-500">{t().editor?.modProfiles?.enabled || "Enabled"}</div>
                      </div>
                      <div class="flex-1 p-2 rounded bg-gray-800">
                        <div class="text-sm font-medium text-gray-400">{stats.disabledCount}</div>
                        <div class="text-xs text-gray-500">{t().editor?.modProfiles?.disabled || "Disabled"}</div>
                      </div>
                    </div>

                    {/* Metadata */}
                    <div class="flex items-center justify-between text-xs text-muted mb-3">
                      <span>{t().editor?.modProfiles?.created || "Created"}: {formatDate(profile.created_at)}</span>
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
                          {t().editor?.modProfiles?.applyProfile || "Apply Profile"}
                        </>
                      }>
                        <i class="i-svg-spinners-6-dots-scale w-4 h-4" />
                        {t().editor?.modProfiles?.applying || "Applying..."}
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
