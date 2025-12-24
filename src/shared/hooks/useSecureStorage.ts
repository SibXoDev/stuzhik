/**
 * Secure storage for sensitive data (passwords, tokens, API keys)
 *
 * ## Architecture (Hybrid Approach)
 *
 * 1. **Primary**: OS Keychain (best protection)
 *    - Windows: Credential Manager (DPAPI)
 *    - macOS: Keychain (user password protected)
 *    - Linux: Secret Service API (gnome-keyring/KWallet)
 *
 * 2. **Fallback**: Device-bound AES-256-GCM encryption
 *    - Used when keychain is unavailable (Linux without DE, servers)
 *    - Key derived from machine_uid + Argon2id
 *    - Encrypted data stored in SQLite
 *
 * ## Security Properties
 *
 * - **Keychain mode**: Protected by OS user password
 * - **Fallback mode**: Device-bound (can't decrypt on another machine)
 * - **AES-256-GCM**: Authenticated encryption (confidentiality + integrity)
 * - **Argon2id**: Memory-hard KDF (resists GPU/ASIC attacks)
 *
 * NEVER store secrets in localStorage or IndexedDB!
 */

import { invoke } from "@tauri-apps/api/core";
import { createSignal } from "solid-js";
import type { SecretMigrationResult } from "../types/common.types";

// ============================================================================
// Types
// ============================================================================

/** Storage backend being used */
export type StorageBackend = "os_keychain" | "encrypted_db";

// ============================================================================
// Universal Secret API
// ============================================================================

/**
 * Store any secret value securely
 *
 * @param key - Unique identifier for the secret
 * @param value - The secret value to store
 *
 * @example
 * await storeSecret("my_api_key", "sk-1234567890");
 */
export async function storeSecret(key: string, value: string): Promise<void> {
  await invoke("store_secret", { key, value });
}

/**
 * Get a secret value
 *
 * @param key - The secret identifier
 * @returns The secret value, or null if not found
 *
 * @example
 * const apiKey = await getSecret("my_api_key");
 */
export async function getSecret(key: string): Promise<string | null> {
  return await invoke<string | null>("get_secret", { key });
}

/**
 * Delete a secret
 *
 * @param key - The secret identifier
 *
 * @example
 * await deleteSecret("my_api_key");
 */
export async function deleteSecret(key: string): Promise<void> {
  await invoke("delete_secret", { key });
}

/**
 * Check if a secret exists
 *
 * @param key - The secret identifier
 * @returns true if the secret exists
 *
 * @example
 * if (await hasSecret("my_api_key")) { ... }
 */
export async function hasSecret(key: string): Promise<boolean> {
  return await invoke<boolean>("has_secret", { key });
}

/**
 * Get the current storage backend being used
 *
 * @returns "os_keychain" or "encrypted_db"
 *
 * @example
 * const backend = await getStorageBackend();
 * if (backend === "encrypted_db") {
 *   console.log("Note: Using device-bound encryption (keychain unavailable)");
 * }
 */
export async function getStorageBackend(): Promise<StorageBackend> {
  return await invoke<StorageBackend>("get_storage_backend");
}

/**
 * Hook for universal secret storage with loading state
 */
export function useSecrets() {
  const [loading, setLoading] = createSignal(false);
  const [backend, setBackend] = createSignal<StorageBackend | null>(null);

  /**
   * Check storage backend
   */
  const checkBackend = async () => {
    const b = await getStorageBackend();
    setBackend(b);
    return b;
  };

  /**
   * Store a secret with loading state
   */
  const store = async (key: string, value: string) => {
    setLoading(true);
    try {
      await storeSecret(key, value);
    } finally {
      setLoading(false);
    }
  };

  /**
   * Get a secret with loading state
   */
  const get = async (key: string): Promise<string | null> => {
    setLoading(true);
    try {
      return await getSecret(key);
    } finally {
      setLoading(false);
    }
  };

  /**
   * Delete a secret with loading state
   */
  const remove = async (key: string) => {
    setLoading(true);
    try {
      await deleteSecret(key);
    } finally {
      setLoading(false);
    }
  };

  /**
   * Check if a secret exists with loading state
   */
  const exists = async (key: string): Promise<boolean> => {
    setLoading(true);
    try {
      return await hasSecret(key);
    } finally {
      setLoading(false);
    }
  };

  return {
    loading,
    backend,
    checkBackend,
    store,
    get,
    remove,
    exists,
  };
}

// ============================================================================
// Typed Convenience Hooks (Auth Token, RCON Password)
// ============================================================================

/**
 * Hook for managing authentication tokens in secure storage
 */
export function useAuthToken() {
  const [hasToken, setHasToken] = createSignal(false);
  const [loading, setLoading] = createSignal(false);

  /**
   * Check if an auth token exists in secure storage
   */
  const checkToken = async () => {
    setLoading(true);
    try {
      const exists = await invoke<boolean>("has_auth_token");
      setHasToken(exists);
      return exists;
    } finally {
      setLoading(false);
    }
  };

  /**
   * Store an auth token in secure storage
   */
  const storeToken = async (token: string) => {
    setLoading(true);
    try {
      await invoke("store_auth_token", { token });
      setHasToken(true);
    } finally {
      setLoading(false);
    }
  };

  /**
   * Get the auth token from secure storage
   * Returns null if no token is stored
   */
  const getToken = async (): Promise<string | null> => {
    setLoading(true);
    try {
      return await invoke<string | null>("get_auth_token");
    } finally {
      setLoading(false);
    }
  };

  /**
   * Delete the auth token from secure storage
   */
  const deleteToken = async () => {
    setLoading(true);
    try {
      await invoke("delete_auth_token");
      setHasToken(false);
    } finally {
      setLoading(false);
    }
  };

  return {
    hasToken,
    loading,
    checkToken,
    storeToken,
    getToken,
    deleteToken,
  };
}

/**
 * Hook for managing RCON passwords in secure storage
 */
export function useRconPassword() {
  const [loading, setLoading] = createSignal(false);

  /**
   * Store RCON password for an instance
   */
  const storePassword = async (instanceId: string, password: string) => {
    setLoading(true);
    try {
      await invoke("store_rcon_password", { instanceId, password });
    } finally {
      setLoading(false);
    }
  };

  /**
   * Get RCON password for an instance
   * Returns null if no password is stored
   */
  const getPassword = async (instanceId: string): Promise<string | null> => {
    setLoading(true);
    try {
      return await invoke<string | null>("get_rcon_password", { instanceId });
    } finally {
      setLoading(false);
    }
  };

  /**
   * Delete RCON password for an instance
   */
  const deletePassword = async (instanceId: string) => {
    setLoading(true);
    try {
      await invoke("delete_rcon_password", { instanceId });
    } finally {
      setLoading(false);
    }
  };

  return {
    loading,
    storePassword,
    getPassword,
    deletePassword,
  };
}

/**
 * Migrate legacy plaintext secrets to secure storage
 * Call this once during app startup
 */
export async function migrateLegacySecrets(): Promise<SecretMigrationResult> {
  return await invoke<SecretMigrationResult>("migrate_legacy_secrets");
}

// ============================================================================
// Diagnostic Test
// ============================================================================

/** Result of the secure storage diagnostic test */
export interface SecureStorageTestResult {
  /** Whether the test passed */
  success: boolean;
  /** Which backend is being used: "os_keychain" or "encrypted_db" */
  backend: string;
  /** Detailed message about the test result */
  message: string;
  /** Time taken in milliseconds */
  time_ms: number;
}

/**
 * Run a diagnostic test of the secure storage system
 *
 * Tests roundtrip: store → get → verify → delete
 *
 * @returns Test result with backend info and timing
 *
 * @example
 * const result = await testSecureStorage();
 * if (result.success) {
 *   console.log(`✅ ${result.message}`);
 * } else {
 *   console.error(`❌ ${result.message}`);
 * }
 */
export async function testSecureStorage(): Promise<SecureStorageTestResult> {
  return await invoke<SecureStorageTestResult>("test_secure_storage");
}
