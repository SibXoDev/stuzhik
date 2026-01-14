import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { ModProfile } from "../types";
import { createAsyncState, runAsync, isValidInstanceId } from "./useAsyncUtils";

const LOG_PREFIX = "[ModProfiles]";

export function useModProfiles(instanceId: () => string) {
  const [profiles, setProfiles] = createSignal<ModProfile[]>([]);
  const { loading, setLoading, error, setError } = createAsyncState();

  async function loadProfiles() {
    const id = instanceId();
    if (!isValidInstanceId(id)) return;

    await runAsync(
      () => invoke<ModProfile[]>("list_mod_profiles", { instanceId: id }),
      { setLoading, setError, logPrefix: LOG_PREFIX, onSuccess: setProfiles }
    );
  }

  async function saveProfile(
    name: string,
    description: string | null,
    enabledModIds: number[]
  ): Promise<string | null> {
    const id = instanceId();
    if (!isValidInstanceId(id)) return null;

    return runAsync(
      () => invoke<string>("save_mod_profile", {
        instanceId: id,
        name,
        description,
        enabledModIds,
      }),
      { setError, logPrefix: LOG_PREFIX, onSuccess: () => loadProfiles() }
    );
  }

  async function applyProfile(profileId: string): Promise<boolean> {
    const id = instanceId();
    if (!isValidInstanceId(id)) return false;

    const result = await runAsync(
      () => invoke<void>("apply_mod_profile", { instanceId: id, profileId }),
      { setError, logPrefix: LOG_PREFIX }
    );
    return result !== null;
  }

  async function deleteProfile(profileId: string): Promise<boolean> {
    const id = instanceId();
    if (!isValidInstanceId(id)) return false;

    const result = await runAsync(
      () => invoke<void>("delete_mod_profile", { instanceId: id, profileId }),
      { setError, logPrefix: LOG_PREFIX, onSuccess: () => loadProfiles() }
    );
    return result !== null;
  }

  return {
    profiles,
    loading,
    error,
    loadProfiles,
    saveProfile,
    applyProfile,
    deleteProfile,
  };
}
