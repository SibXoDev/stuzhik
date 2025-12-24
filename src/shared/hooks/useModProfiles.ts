import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { ModProfile } from "../types";

export function useModProfiles(instanceId: () => string) {
  const [profiles, setProfiles] = createSignal<ModProfile[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  async function loadProfiles() {
    if (!instanceId()) return;

    try {
      setLoading(true);
      setError(null);
      const profilesList = await invoke<ModProfile[]>("list_mod_profiles", {
        instanceId: instanceId(),
      });
      setProfiles(profilesList);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      console.error("Failed to load mod profiles:", e);
    } finally {
      setLoading(false);
    }
  }

  async function saveProfile(
    name: string,
    description: string | null,
    enabledModIds: number[]
  ): Promise<string | null> {
    try {
      setError(null);
      const profileId = await invoke<string>("save_mod_profile", {
        instanceId: instanceId(),
        name,
        description,
        enabledModIds,
      });
      await loadProfiles();
      return profileId;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      console.error("Failed to save mod profile:", e);
      return null;
    }
  }

  async function applyProfile(profileId: string): Promise<boolean> {
    try {
      setError(null);
      await invoke("apply_mod_profile", {
        instanceId: instanceId(),
        profileId,
      });
      return true;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      console.error("Failed to apply mod profile:", e);
      return false;
    }
  }

  async function deleteProfile(profileId: string): Promise<boolean> {
    try {
      setError(null);
      await invoke("delete_mod_profile", {
        instanceId: instanceId(),
        profileId,
      });
      await loadProfiles();
      return true;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      console.error("Failed to delete mod profile:", e);
      return false;
    }
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
