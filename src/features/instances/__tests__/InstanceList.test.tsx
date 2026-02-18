import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@solidjs/testing-library';
import type { JSX } from 'solid-js';
import InstanceList from '../components/InstanceList';
import type { Instance } from '../../../shared/types';
import { I18nProvider } from '../../../shared/i18n';

// Wrapper component to provide i18n context
const TestWrapper = (props: { children: JSX.Element }) => (
  <I18nProvider initialLanguage="ru">{props.children}</I18nProvider>
);

const mockInstance: Instance = {
  id: 'test-1',
  name: 'Test Instance',
  game_type: 'minecraft',
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
  total_playtime: 3600,
  last_played: '2025-12-01T00:00:00Z',
  created_at: '2025-12-01T00:00:00Z',
  updated_at: '2025-12-01T00:00:00Z',
};

describe('InstanceList', () => {
  it('should render empty state when no instances', () => {
    render(() => (
      <TestWrapper>
        <InstanceList
          instances={[]}
          onStart={vi.fn()}
          onStop={vi.fn()}
          onDelete={vi.fn()}
          onRepair={vi.fn()}
          onConfigure={vi.fn()}
        />
      </TestWrapper>
    ));

    // Проверяем заголовок пустого состояния
    expect(screen.getByText('Начните своё приключение')).toBeInTheDocument();
  });

  it('should render instances list', () => {
    render(() => (
      <TestWrapper>
        <InstanceList
          instances={[mockInstance]}
          onStart={vi.fn()}
          onStop={vi.fn()}
          onDelete={vi.fn()}
          onRepair={vi.fn()}
          onConfigure={vi.fn()}
        />
      </TestWrapper>
    ));

    expect(screen.getByText('Test Instance')).toBeInTheDocument();
    expect(screen.getByText('1.20.1')).toBeInTheDocument();
  });

  it('should show play button for stopped instance', () => {
    render(() => (
      <TestWrapper>
        <InstanceList
          instances={[mockInstance]}
          onStart={vi.fn()}
          onStop={vi.fn()}
          onDelete={vi.fn()}
          onRepair={vi.fn()}
          onConfigure={vi.fn()}
        />
      </TestWrapper>
    ));

    // Проверяем наличие кнопки play по тексту
    expect(screen.getByText('Играть')).toBeInTheDocument();
  });

  it('should show stop button for running instance', () => {
    const runningInstance = { ...mockInstance, status: 'running' as const };

    render(() => (
      <TestWrapper>
        <InstanceList
          instances={[runningInstance]}
          onStart={vi.fn()}
          onStop={vi.fn()}
          onDelete={vi.fn()}
          onRepair={vi.fn()}
          onConfigure={vi.fn()}
        />
      </TestWrapper>
    ));

    // Проверяем наличие кнопки stop по тексту
    expect(screen.getByText('Стоп')).toBeInTheDocument();
  });

  it('should show installing state', () => {
    const installingInstance: Instance = {
      ...mockInstance,
      status: 'installing' as const,
    };

    render(() => (
      <TestWrapper>
        <InstanceList
          instances={[installingInstance]}
          onStart={vi.fn()}
          onStop={vi.fn()}
          onDelete={vi.fn()}
          onRepair={vi.fn()}
          onConfigure={vi.fn()}
        />
      </TestWrapper>
    ));

    // Проверяем наличие текста статуса установки
    expect(screen.getByText('Устанавливается')).toBeInTheDocument();
  });

  it('should render multiple instances', () => {
    const instances: Instance[] = [
      mockInstance,
      { ...mockInstance, id: 'test-2', name: 'Instance 2' },
      { ...mockInstance, id: 'test-3', name: 'Instance 3' },
    ];

    render(() => (
      <TestWrapper>
        <InstanceList
          instances={instances}
          onStart={vi.fn()}
          onStop={vi.fn()}
          onDelete={vi.fn()}
          onRepair={vi.fn()}
          onConfigure={vi.fn()}
        />
      </TestWrapper>
    ));

    expect(screen.getByText('Test Instance')).toBeInTheDocument();
    expect(screen.getByText('Instance 2')).toBeInTheDocument();
    expect(screen.getByText('Instance 3')).toBeInTheDocument();
  });
});
