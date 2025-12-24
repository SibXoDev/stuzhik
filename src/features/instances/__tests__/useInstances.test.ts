import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { createRoot } from 'solid-js';
import { useInstances } from '../hooks/useInstances';
import type { Instance, CreateInstanceRequest } from '../../../shared/types';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

// Mock data
const mockInstance: Instance = {
  id: 'test-instance-1',
  name: 'Test Instance',
  version: '1.20.1',
  loader: 'forge',
  loader_version: '47.2.0',
  instance_type: 'client',
  status: 'stopped',
  dir: '/path/to/instance',
  memory_min: 1024,
  memory_max: 4096,
  rcon_enabled: false,
  auto_restart: false,
  total_playtime: 0,
  last_played: '2025-12-01T00:00:00Z',
  created_at: '2025-12-01T00:00:00Z',
  updated_at: '2025-12-01T00:00:00Z',
};

describe('useInstances', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should initialize with empty state', () => {
    createRoot((dispose) => {
      const hook = useInstances();

      expect(hook.instances()).toEqual([]);
      expect(hook.loading()).toBe(false);
      expect(hook.error()).toBe(null);

      dispose();
    });
  });

  it('should load instances on mount', async () => {
    const mockInstances: Instance[] = [mockInstance];
    (invoke as Mock).mockResolvedValue(mockInstances);
    (listen as Mock).mockResolvedValue(() => {});

    await new Promise<void>((resolve) => {
      createRoot((dispose) => {
        const hook = useInstances();

        // Wait for onMount to complete
        setTimeout(() => {
          expect(invoke).toHaveBeenCalledWith('list_instances');
          expect(hook.instances()).toEqual(mockInstances);
          expect(hook.loading()).toBe(false);

          dispose();
          resolve();
        }, 10);
      });
    });
  });

  it('should handle load errors', async () => {
    const errorMessage = 'Failed to load';
    (invoke as Mock).mockRejectedValue(new Error(errorMessage));
    (listen as Mock).mockResolvedValue(() => {});

    await new Promise<void>((resolve) => {
      createRoot((dispose) => {
        const hook = useInstances();

        setTimeout(() => {
          expect(hook.error()).toBe(errorMessage);
          expect(hook.loading()).toBe(false);

          dispose();
          resolve();
        }, 10);
      });
    });
  });

  it('should create instance successfully', async () => {
    (invoke as Mock)
      .mockResolvedValueOnce([]) // list_instances call on mount
      .mockResolvedValueOnce(mockInstance); // create_instance call
    (listen as Mock).mockResolvedValue(() => {});

    await new Promise<void>((resolve) => {
      createRoot(async (dispose) => {
        const hook = useInstances();

        // Wait for initial load to complete
        await new Promise((r) => setTimeout(r, 10));

        const request: CreateInstanceRequest = {
          name: 'Test Instance',
          version: '1.20.1',
          loader: 'forge',
          loader_version: '47.2.0',
          instance_type: 'client',
        };

        const result = await hook.createInstance(request);

        expect(result).toEqual(mockInstance);
        expect(hook.instances()).toContainEqual(mockInstance);
        expect(invoke).toHaveBeenCalledWith('create_instance', { req: request });

        dispose();
        resolve();
      });
    });
  });

  it('should start instance and update status', async () => {
    const instances = [{ ...mockInstance, status: 'stopped' as const }];
    (invoke as Mock)
      .mockResolvedValueOnce(instances)
      .mockResolvedValueOnce(undefined);
    (listen as Mock).mockResolvedValue(() => {});

    await new Promise<void>((resolve) => {
      createRoot(async (dispose) => {
        const hook = useInstances();

        // Wait for initial load
        await new Promise((r) => setTimeout(r, 10));

        await hook.startInstance(mockInstance.id);

        expect(invoke).toHaveBeenCalledWith('start_instance', {
          id: mockInstance.id,
        });

        const instance = hook.instances().find((i) => i.id === mockInstance.id);
        expect(instance?.status).toBe('starting');

        dispose();
        resolve();
      });
    });
  });

  it('should stop instance and update status', async () => {
    const instances = [{ ...mockInstance, status: 'running' as const }];
    (invoke as Mock)
      .mockResolvedValueOnce(instances)
      .mockResolvedValueOnce(undefined);
    (listen as Mock).mockResolvedValue(() => {});

    await new Promise<void>((resolve) => {
      createRoot(async (dispose) => {
        const hook = useInstances();

        await new Promise((r) => setTimeout(r, 10));

        await hook.stopInstance(mockInstance.id);

        expect(invoke).toHaveBeenCalledWith('stop_instance', {
          id: mockInstance.id,
        });

        const instance = hook.instances().find((i) => i.id === mockInstance.id);
        expect(instance?.status).toBe('stopping');

        dispose();
        resolve();
      });
    });
  });

  it('should delete instance', async () => {
    const instances = [mockInstance];
    (invoke as Mock)
      .mockResolvedValueOnce(instances)
      .mockResolvedValueOnce(undefined);
    (listen as Mock).mockResolvedValue(() => {});

    await new Promise<void>((resolve) => {
      createRoot(async (dispose) => {
        const hook = useInstances();

        await new Promise((r) => setTimeout(r, 10));

        await hook.deleteInstance(mockInstance.id);

        expect(invoke).toHaveBeenCalledWith('delete_instance', {
          id: mockInstance.id,
        });
        expect(hook.instances()).not.toContainEqual(mockInstance);

        dispose();
        resolve();
      });
    });
  });

  it('should prevent concurrent operations on same instance', async () => {
    const instances = [mockInstance];
    (invoke as Mock).mockResolvedValue(instances);
    (listen as Mock).mockResolvedValue(() => {});

    await new Promise<void>((resolve) => {
      createRoot(async (dispose) => {
        const hook = useInstances();

        await new Promise((r) => setTimeout(r, 10));

        // Start first operation
        const promise1 = hook.startInstance(mockInstance.id);
        // Try to start again immediately
        const promise2 = hook.startInstance(mockInstance.id);

        await Promise.all([promise1, promise2]);

        // Should only be called once
        expect(invoke).toHaveBeenCalledTimes(2); // 1 for load, 1 for start

        dispose();
        resolve();
      });
    });
  });

  it('should update instance', async () => {
    const instances = [mockInstance];
    const updated = { ...mockInstance, name: 'Updated Name' };
    (invoke as Mock)
      .mockResolvedValueOnce(instances)
      .mockResolvedValueOnce(updated);
    (listen as Mock).mockResolvedValue(() => {});

    await new Promise<void>((resolve) => {
      createRoot(async (dispose) => {
        const hook = useInstances();

        await new Promise((r) => setTimeout(r, 10));

        await hook.updateInstance(mockInstance.id, { name: 'Updated Name' });

        expect(invoke).toHaveBeenCalledWith('update_instance', {
          id: mockInstance.id,
          updates: { name: 'Updated Name' },
        });

        const instance = hook.instances().find((i) => i.id === mockInstance.id);
        expect(instance?.name).toBe('Updated Name');

        dispose();
        resolve();
      });
    });
  });
});
