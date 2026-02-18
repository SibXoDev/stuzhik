import { Component, createSignal, For, Show, onMount, createMemo } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { Toggle, Select, Tabs } from "../../../shared/ui";
import { Tooltip } from "../../../shared/ui/Tooltip";
import ServerP2PPanel from "./ServerP2PPanel";
import { useI18n } from "../../../shared/i18n";

interface ServerProperties {
  [key: string]: string | number | boolean | object;
}

interface EulaStatus {
  accepted: boolean;
  file_exists: boolean;
}

interface WhitelistEntry {
  uuid: string;
  name: string;
}

interface OpEntry {
  uuid: string;
  name: string;
  level: number;
  bypasses_player_limit: boolean;
}

interface BannedPlayer {
  uuid: string;
  name: string;
  created: string;
  source: string;
  expires: string;
  reason: string;
}

interface PlayerManagement {
  whitelist: WhitelistEntry[];
  ops: OpEntry[];
  banned_players: BannedPlayer[];
  banned_ips: { ip: string; reason: string }[];
}

interface Props {
  instanceId: string;
  isRunning?: boolean;
  minecraftVersion?: string;
}

type MainTab = "properties" | "players" | "eula" | "p2p";

// Property definition with full info
interface PropertyDef {
  label: string;
  description: string;
  type: "text" | "number" | "boolean" | "select";
  options?: { value: string; label: string }[];
  optionsByVersion?: Record<string, { value: string; label: string }[]>;
  min?: number;
  max?: number;
  default: string;
  defaultByVersion?: Record<string, string>;
  group: string;
  minVersion?: string; // Minimum Minecraft version required
}

// All server properties with descriptions and defaults
const PROPERTY_DEFINITIONS: Record<string, PropertyDef> = {
  // === Network ===
  "server-port": {
    label: "Порт сервера",
    description: "TCP порт для подключения клиентов",
    type: "number",
    min: 1,
    max: 65535,
    default: "25565",
    group: "network",
  },
  "server-ip": {
    label: "IP адрес",
    description: "Привязка к конкретному IP. Пусто = все интерфейсы",
    type: "text",
    default: "",
    group: "network",
  },
  "online-mode": {
    label: "Лицензионный режим",
    description: "Проверять лицензию Minecraft. Выключите для пиратов",
    type: "boolean",
    default: "true",
    group: "network",
  },
  "max-players": {
    label: "Макс. игроков",
    description: "Максимальное количество игроков",
    type: "number",
    min: 1,
    max: 1000,
    default: "20",
    group: "network",
  },
  "motd": {
    label: "Описание сервера (MOTD)",
    description: "Отображается в списке серверов. Поддерживает § для цветов",
    type: "text",
    default: "A Minecraft Server",
    group: "network",
  },
  "network-compression-threshold": {
    label: "Порог сжатия пакетов",
    description: "Минимальный размер для сжатия (байт). -1 = отключено",
    type: "number",
    min: -1,
    max: 65535,
    default: "256",
    group: "network",
  },
  "prevent-proxy-connections": {
    label: "Блокировать прокси",
    description: "Блокировать подключения через VPN/прокси",
    type: "boolean",
    default: "false",
    group: "network",
  },
  "rate-limit": {
    label: "Лимит пакетов",
    description: "Макс. пакетов от клиента в секунду. 0 = без лимита",
    type: "number",
    min: 0,
    max: 10000,
    default: "0",
    group: "network",
  },

  // === World ===
  "level-name": {
    label: "Название мира",
    description: "Имя папки с миром",
    type: "text",
    default: "world",
    group: "world",
  },
  "level-seed": {
    label: "Сид мира",
    description: "Сид для генерации (пусто = случайный)",
    type: "text",
    default: "",
    group: "world",
  },
  "level-type": {
    label: "Тип мира",
    description: "Тип генерации мира",
    type: "select",
    options: [
      { value: "minecraft:normal", label: "Обычный" },
      { value: "minecraft:flat", label: "Плоский" },
      { value: "minecraft:large_biomes", label: "Большие биомы" },
      { value: "minecraft:amplified", label: "Усиленный" },
      { value: "minecraft:single_biome_surface", label: "Один биом" },
    ],
    default: "minecraft:normal",
    group: "world",
  },
  "generator-settings": {
    label: "Настройки генератора",
    description: "JSON настройки для плоского мира",
    type: "text",
    default: "{}",
    group: "world",
  },
  "generate-structures": {
    label: "Генерация структур",
    description: "Деревни, крепости, храмы и т.д.",
    type: "boolean",
    default: "true",
    group: "world",
  },
  "allow-nether": {
    label: "Незер",
    description: "Разрешить порталы в Незер",
    type: "boolean",
    default: "true",
    group: "world",
  },
  "spawn-protection": {
    label: "Защита спавна",
    description: "Радиус защиты точки спавна. 0 = отключено",
    type: "number",
    min: 0,
    max: 100,
    default: "16",
    group: "world",
  },
  "max-world-size": {
    label: "Макс. размер мира",
    description: "Максимальный радиус мира (блоков)",
    type: "number",
    min: 1,
    max: 29999984,
    default: "29999984",
    group: "world",
  },

  // === Gameplay ===
  "difficulty": {
    label: "Сложность",
    description: "Уровень сложности игры",
    type: "select",
    options: [
      { value: "peaceful", label: "Мирная" },
      { value: "easy", label: "Лёгкая" },
      { value: "normal", label: "Нормальная" },
      { value: "hard", label: "Сложная" },
    ],
    default: "easy",
    group: "gameplay",
  },
  "gamemode": {
    label: "Режим игры",
    description: "Режим по умолчанию для новых игроков",
    type: "select",
    options: [
      { value: "survival", label: "Выживание" },
      { value: "creative", label: "Творческий" },
      { value: "adventure", label: "Приключение" },
      { value: "spectator", label: "Наблюдатель" },
    ],
    default: "survival",
    group: "gameplay",
  },
  "force-gamemode": {
    label: "Принудительный режим",
    description: "Сбрасывать режим при входе на сервер",
    type: "boolean",
    default: "false",
    group: "gameplay",
  },
  "hardcore": {
    label: "Хардкор",
    description: "Режим одной жизни",
    type: "boolean",
    default: "false",
    group: "gameplay",
  },
  "pvp": {
    label: "PvP",
    description: "Разрешить бой между игроками",
    type: "boolean",
    default: "true",
    group: "gameplay",
  },
  "allow-flight": {
    label: "Разрешить полёт",
    description: "Не кикать за полёт (для модов)",
    type: "boolean",
    default: "false",
    group: "gameplay",
  },
  "spawn-monsters": {
    label: "Спавн мобов",
    description: "Спавнить враждебных мобов",
    type: "boolean",
    default: "true",
    group: "gameplay",
  },
  "spawn-animals": {
    label: "Спавн животных",
    description: "Спавнить мирных животных",
    type: "boolean",
    default: "true",
    group: "gameplay",
  },
  "spawn-npcs": {
    label: "Спавн NPC",
    description: "Спавнить жителей",
    type: "boolean",
    default: "true",
    group: "gameplay",
  },
  "enable-command-block": {
    label: "Командные блоки",
    description: "Разрешить командные блоки",
    type: "boolean",
    default: "false",
    group: "gameplay",
  },
  "max-build-height": {
    label: "Макс. высота постройки",
    description: "Максимальная высота для строительства",
    type: "number",
    min: 0,
    max: 320,
    default: "256",
    group: "gameplay",
  },
  "player-idle-timeout": {
    label: "Таймаут AFK",
    description: "Минут до кика за AFK. 0 = отключено",
    type: "number",
    min: 0,
    max: 1440,
    default: "0",
    group: "gameplay",
  },

  // === Performance ===
  "view-distance": {
    label: "Дальность прорисовки",
    description: "Дальность отрисовки чанков",
    type: "number",
    min: 2,
    max: 32,
    default: "10",
    group: "performance",
  },
  "simulation-distance": {
    label: "Дальность симуляции",
    description: "Дальность симуляции сущностей (чанков)",
    type: "number",
    min: 2,
    max: 32,
    default: "10",
    group: "performance",
  },
  "max-tick-time": {
    label: "Макс. время тика",
    description: "Мс до остановки при лаге. -1 = отключено",
    type: "number",
    min: -1,
    max: 60000,
    default: "60000",
    group: "performance",
  },
  "entity-broadcast-range-percentage": {
    label: "Дальность сущностей %",
    description: "% от дальности для отправки сущностей",
    type: "number",
    min: 10,
    max: 1000,
    default: "100",
    group: "performance",
  },
  "sync-chunk-writes": {
    label: "Синхронная запись чанков",
    description: "Синхронная запись для защиты данных",
    type: "boolean",
    default: "true",
    group: "performance",
  },

  // === Security ===
  "white-list": {
    label: "Белый список",
    description: "Только игроки из whitelist",
    type: "boolean",
    default: "false",
    group: "security",
  },
  "enforce-whitelist": {
    label: "Строгий whitelist",
    description: "Кикать удалённых из whitelist",
    type: "boolean",
    default: "false",
    group: "security",
  },
  "enforce-secure-profile": {
    label: "Безопасный профиль",
    description: "Требовать подпись Mojang для чата",
    type: "boolean",
    default: "true",
    group: "security",
  },
  "op-permission-level": {
    label: "Уровень OP",
    description: "Уровень прав операторов (1-4)",
    type: "number",
    min: 1,
    max: 4,
    default: "4",
    group: "security",
  },
  "function-permission-level": {
    label: "Уровень функций",
    description: "Уровень прав для датапаков",
    type: "number",
    min: 1,
    max: 4,
    default: "2",
    group: "security",
  },
  "hide-online-players": {
    label: "Скрыть онлайн",
    description: "Скрыть список игроков в статусе",
    type: "boolean",
    default: "false",
    group: "security",
  },

  // === RCON ===
  "enable-rcon": {
    label: "Включить RCON",
    description: "Удалённое управление через RCON",
    type: "boolean",
    default: "false",
    group: "rcon",
  },
  "rcon.port": {
    label: "RCON порт",
    description: "Порт для RCON",
    type: "number",
    min: 1,
    max: 65535,
    default: "25575",
    group: "rcon",
  },
  "rcon.password": {
    label: "RCON пароль",
    description: "Пароль для RCON",
    type: "text",
    default: "",
    group: "rcon",
  },
  "broadcast-rcon-to-ops": {
    label: "RCON в чат",
    description: "Показывать RCON команды операторам",
    type: "boolean",
    default: "true",
    group: "rcon",
  },

  // === Query ===
  "enable-query": {
    label: "Включить Query",
    description: "GameSpy4 протокол для мониторинга",
    type: "boolean",
    default: "false",
    group: "query",
  },
  "query.port": {
    label: "Query порт",
    description: "Порт для Query",
    type: "number",
    min: 1,
    max: 65535,
    default: "25565",
    group: "query",
  },

  // === Advanced ===
  "enable-jmx-monitoring": {
    label: "JMX мониторинг",
    description: "Включить JMX мониторинг",
    type: "boolean",
    default: "false",
    group: "advanced",
  },
  "enable-status": {
    label: "Статус сервера",
    description: "Отвечать на запросы статуса",
    type: "boolean",
    default: "true",
    group: "advanced",
  },
  "log-ips": {
    label: "Логировать IP",
    description: "Записывать IP адреса в логи",
    type: "boolean",
    default: "true",
    group: "advanced",
  },
  "use-native-transport": {
    label: "Native транспорт",
    description: "Использовать оптимизированные Linux I/O",
    type: "boolean",
    default: "true",
    group: "advanced",
  },
  "debug": {
    label: "Режим отладки",
    description: "Включить расширенное логирование",
    type: "boolean",
    default: "false",
    group: "advanced",
  },
  "broadcast-console-to-ops": {
    label: "Консоль в чат",
    description: "Показывать консольные команды операторам",
    type: "boolean",
    default: "true",
    group: "advanced",
  },
  "require-resource-pack": {
    label: "Требовать ресурспак",
    description: "Кикать при отказе от ресурспака",
    type: "boolean",
    default: "false",
    group: "advanced",
  },
  "resource-pack": {
    label: "URL ресурспака",
    description: "URL для скачивания ресурспака",
    type: "text",
    default: "",
    group: "advanced",
  },
  "resource-pack-sha1": {
    label: "SHA1 ресурспака",
    description: "Хеш для проверки ресурспака",
    type: "text",
    default: "",
    group: "advanced",
  },
  "resource-pack-prompt": {
    label: "Текст ресурспака",
    description: "Сообщение при предложении ресурспака",
    type: "text",
    default: "",
    group: "advanced",
  },
  "text-filtering-config": {
    label: "Фильтр текста",
    description: "Конфиг для фильтрации чата",
    type: "text",
    default: "",
    group: "advanced",
  },
};

// Group definitions
const GROUPS = [
  { id: "network", label: "Сеть", icon: "i-hugeicons-wifi-01", description: "Порты, подключения, MOTD" },
  { id: "world", label: "Мир", icon: "i-hugeicons-earth", description: "Генерация, сид, структуры" },
  { id: "gameplay", label: "Геймплей", icon: "i-hugeicons-game-controller-03", description: "Сложность, режим, PvP" },
  { id: "performance", label: "Производительность", icon: "i-hugeicons-dashboard-speed-01", description: "Дальность, тики" },
  { id: "security", label: "Безопасность", icon: "i-hugeicons-lock", description: "Whitelist, права" },
  { id: "rcon", label: "RCON", icon: "i-hugeicons-command-line", description: "Удалённое управление" },
  { id: "query", label: "Query", icon: "i-hugeicons-search-01", description: "GameSpy4 мониторинг" },
  { id: "advanced", label: "Расширенные", icon: "i-hugeicons-settings-02", description: "Дополнительные опции" },
];

const ServerSettings: Component<Props> = (props) => {
  const { t } = useI18n();
  const [mainTab, setMainTab] = createSignal<MainTab>("properties");
  const [selectedGroup, setSelectedGroup] = createSignal("network");
  const [properties, setProperties] = createSignal<ServerProperties>({});
  const [originalProperties, setOriginalProperties] = createSignal<ServerProperties>({});
  const [eulaStatus, setEulaStatus] = createSignal<EulaStatus>({ accepted: false, file_exists: false });
  const [players, setPlayers] = createSignal<PlayerManagement>({
    whitelist: [], ops: [], banned_players: [], banned_ips: []
  });
  const [loading, setLoading] = createSignal(true);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [newPlayerName, setNewPlayerName] = createSignal("");
  const [addingPlayer, setAddingPlayer] = createSignal(false);

  // Convert value to string safely
  const valueToString = (value: unknown): string => {
    if (value === null || value === undefined) return "";
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  };

  // Load data
  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      const [serverProps, eula, playerData] = await Promise.all([
        invoke<ServerProperties>("get_server_properties", { instanceId: props.instanceId }),
        invoke<EulaStatus>("get_eula_status", { instanceId: props.instanceId }),
        invoke<PlayerManagement>("get_player_management", { instanceId: props.instanceId }),
      ]);
      setProperties(serverProps);
      setOriginalProperties({ ...serverProps });
      setEulaStatus(eula);
      setPlayers(playerData);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  onMount(loadData);

  // Get property value with fallback to default
  const getPropertyValue = (key: string): string => {
    const props_data = properties();
    if (props_data[key] !== undefined) {
      return valueToString(props_data[key]);
    }
    const def = PROPERTY_DEFINITIONS[key];
    return def?.default ?? "";
  };

  // Check for unsaved changes
  const hasChanges = createMemo(() => {
    const current = properties();
    const original = originalProperties();

    // Check all defined properties
    for (const key of Object.keys(PROPERTY_DEFINITIONS)) {
      const currentVal = current[key] !== undefined ? valueToString(current[key]) : PROPERTY_DEFINITIONS[key].default;
      const originalVal = original[key] !== undefined ? valueToString(original[key]) : PROPERTY_DEFINITIONS[key].default;
      if (currentVal !== originalVal) return true;
    }

    // Check any custom properties
    for (const key of Object.keys(current)) {
      if (valueToString(current[key]) !== valueToString(original[key])) return true;
    }

    return false;
  });

  // Save properties - convert to proper types based on definitions or original types
  const saveProperties = async () => {
    setSaving(true);
    try {
      const typedProps: Record<string, string | number | boolean> = {};
      const original = originalProperties();

      for (const [key, value] of Object.entries(properties())) {
        const def = PROPERTY_DEFINITIONS[key];
        const strValue = valueToString(value);
        const originalValue = original[key];

        // Use definition type if known
        if (def?.type === "boolean") {
          typedProps[key] = strValue === "true";
        } else if (def?.type === "number") {
          typedProps[key] = parseInt(strValue, 10) || 0;
        }
        // For unknown properties, preserve original type
        else if (typeof originalValue === "boolean") {
          typedProps[key] = strValue === "true";
        } else if (typeof originalValue === "number") {
          typedProps[key] = parseFloat(strValue) || 0;
        } else {
          typedProps[key] = strValue;
        }
      }
      await invoke("save_server_properties", {
        instanceId: props.instanceId,
        properties: typedProps,
      });
      setOriginalProperties({ ...properties() });
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  // Accept EULA
  const acceptEula = async () => {
    try {
      await invoke("accept_server_eula", { instanceId: props.instanceId });
      setEulaStatus({ accepted: true, file_exists: true });
    } catch (e) {
      setError(String(e));
    }
  };

  // Update property
  const updateProperty = (key: string, value: string | boolean) => {
    setProperties(prev => ({ ...prev, [key]: value }));
  };

  // Get properties for a group - show ALL defined properties
  const getGroupProperties = (groupId: string) => {
    const result: { key: string; value: string; def: PropertyDef }[] = [];

    for (const [key, def] of Object.entries(PROPERTY_DEFINITIONS)) {
      if (def.group === groupId) {
        result.push({ key, value: getPropertyValue(key), def });
      }
    }

    return result;
  };

  // Player management functions
  const addToWhitelist = async () => {
    const name = newPlayerName().trim();
    if (!name) return;
    setAddingPlayer(true);
    try {
      await invoke("whitelist_add", { instanceId: props.instanceId, username: name });
      await loadData();
      setNewPlayerName("");
    } catch (e) {
      setError(String(e));
    } finally {
      setAddingPlayer(false);
    }
  };

  const removeFromWhitelist = async (username: string) => {
    try {
      await invoke("whitelist_remove", { instanceId: props.instanceId, username });
      await loadData();
    } catch (e) {
      setError(String(e));
    }
  };

  const addOperator = async (level: number = 4) => {
    const name = newPlayerName().trim();
    if (!name) return;
    setAddingPlayer(true);
    try {
      await invoke("op_add", { instanceId: props.instanceId, username: name, level });
      await loadData();
      setNewPlayerName("");
    } catch (e) {
      setError(String(e));
    } finally {
      setAddingPlayer(false);
    }
  };

  const removeOperator = async (username: string) => {
    try {
      await invoke("op_remove", { instanceId: props.instanceId, username });
      await loadData();
    } catch (e) {
      setError(String(e));
    }
  };

  const unbanPlayer = async (username: string) => {
    try {
      await invoke("player_unban", { instanceId: props.instanceId, username });
      await loadData();
    } catch (e) {
      setError(String(e));
    }
  };

  // Render property input
  const renderPropertyInput = (key: string, value: string, def: PropertyDef) => {
    if (def.type === "boolean") {
      return (
        <Toggle
          checked={value === "true"}
          onChange={(checked) => updateProperty(key, checked ? "true" : "false")}
        />
      );
    }

    if (def.type === "select" && def.options) {
      return (
        <Select
          value={value}
          onChange={(val) => updateProperty(key, val)}
          options={def.options}
        />
      );
    }

    if (def.type === "number") {
      return (
        <input
          type="number"
          class="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-300 w-full"
          value={value}
          min={def.min}
          max={def.max}
          onInput={(e) => updateProperty(key, e.currentTarget.value)}
        />
      );
    }

    return (
      <input
        type="text"
        class="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-300 w-full"
        value={value}
        onInput={(e) => updateProperty(key, e.currentTarget.value)}
      />
    );
  };

  const mainTabs: { id: MainTab; label: string; icon: string }[] = [
    { id: "properties", label: "Настройки", icon: "i-hugeicons-settings-02" },
    { id: "players", label: "Игроки", icon: "i-hugeicons-user-group" },
    { id: "eula", label: "EULA", icon: "i-hugeicons-file-01" },
    { id: "p2p", label: "P2P Sync", icon: "i-hugeicons-wifi-01" },
  ];

  return (
    <div class="flex flex-col h-full gap-4">
      {/* Error banner */}
      <Show when={error()}>
        <div class="bg-red-500/10 border border-red-500/30 rounded-lg p-3 text-red-400 text-sm flex items-center justify-between">
          <span>{error()}</span>
          <button onClick={() => setError(null)} class="text-red-300 hover:text-white">
            <i class="i-hugeicons-cancel-01 w-4 h-4" />
          </button>
        </div>
      </Show>

      {/* Restart warning */}
      <Show when={hasChanges() && props.isRunning}>
        <div class="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-3 text-yellow-400 text-sm flex items-center gap-2">
          <i class="i-hugeicons-alert-02 w-4 h-4 flex-shrink-0" />
          <span>Изменения вступят в силу после перезапуска сервера</span>
        </div>
      </Show>

      {/* Main tabs */}
      <div class="flex-shrink-0">
        <Tabs
          tabs={mainTabs.map(tab => ({ id: tab.id, label: tab.label, icon: tab.icon }))}
          activeTab={mainTab()}
          onTabChange={(id) => setMainTab(id as MainTab)}
          variant="pills"
        />
      </div>

      {/* Content */}
      <div class="flex-1 overflow-hidden min-h-0">
        <Show when={loading()}>
          <div class="flex items-center justify-center h-full">
            <i class="i-svg-spinners-6-dots-scale w-8 h-8 text-[var(--color-primary)]" />
          </div>
        </Show>

        {/* Properties tab - two column layout */}
        <Show when={!loading() && mainTab() === "properties"}>
          <div class="flex gap-2 h-full w-full">
            {/* Left sidebar - categories */}
            <div class="w-fit min-w-fit flex flex-col overflow-y-auto gap-1">
              <For each={GROUPS}>
                {(group) => (
                  <button
                    class={`w-full text-left px-3 py-2.5 rounded-lg transition-colors flex items-center justify-start gap-3 ${
                      selectedGroup() === group.id
                        ? "bg-[var(--color-primary-bg)] text-[var(--color-primary)] border border-[var(--color-primary-border)]"
                        : "hover:bg-gray-800 text-gray-400"
                    }`}
                    onClick={() => setSelectedGroup(group.id)}
                  >
                    <i class={`${group.icon} w-5 h-5 flex-shrink-0`} />
                    <div class="min-w-0">
                      <div class="font-medium text-sm">{group.label}</div>
                      <div class="text-xs text-gray-500 truncate">{group.description}</div>
                    </div>
                  </button>
                )}
              </For>
            </div>

            {/* Right content - settings for selected category */}
            <div class="flex flex-col w-full h-full overflow-y-auto gap-1">
              <For each={getGroupProperties(selectedGroup())}>
                {({ key, value, def }) => (
                  <div class="bg-gray-900/90 rounded-lg p-4">
                    <div class="flex items-start gap-4">
                      <div class="flex-1 min-w-0">
                        <div class="font-medium text-sm text-gray-200">{def.label}</div>
                        <div class="text-xs text-gray-500 mt-0.5">{def.description}</div>
                        <div class="text-xs text-gray-600 mt-1 font-mono">{key}</div>
                      </div>
                      <div class="flex-shrink-0 w-48">
                        {renderPropertyInput(key, value, def)}
                      </div>
                    </div>
                  </div>
                )}
              </For>

              {/* Save button */}
              <Show when={hasChanges()}>
                <div class="sticky bottom-0 bg-gradient-to-t from-gray-900 via-gray-900 to-transparent pt-2">
                  <button
                    class="btn-primary w-full"
                    onClick={saveProperties}
                    disabled={saving()}
                  >
                    <Show when={saving()} fallback={<><i class="i-hugeicons-floppy-disk w-4 h-4" /> Сохранить изменения</>}>
                      <i class="i-svg-spinners-6-dots-scale w-4 h-4" /> Сохранение...
                    </Show>
                  </button>
                </div>
              </Show>
            </div>
          </div>
        </Show>

        {/* Players tab */}
        <Show when={!loading() && mainTab() === "players"}>
          <div class="space-y-4 overflow-y-auto h-full">
            {/* Add player input */}
            <div class="card flex items-center gap-3">
              <input
                type="text"
                class="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-sm text-gray-300"
                placeholder={t().ui?.placeholders?.enterPlayerNick ?? "Enter player nickname..."}
                value={newPlayerName()}
                onInput={(e) => setNewPlayerName(e.currentTarget.value)}
                onKeyDown={(e) => e.key === "Enter" && addToWhitelist()}
              />
              <button
                class="btn-secondary text-sm"
                onClick={() => addToWhitelist()}
                disabled={addingPlayer() || !newPlayerName().trim()}
              >
                <i class="i-hugeicons-add-01 w-4 h-4" />
                Whitelist
              </button>
              <button
                class="btn-secondary text-sm"
                onClick={() => addOperator()}
                disabled={addingPlayer() || !newPlayerName().trim()}
              >
                <i class="i-hugeicons-user-settings-01 w-4 h-4" />
                OP
              </button>
            </div>

            <div class="grid grid-cols-2 gap-4">
              {/* Whitelist */}
              <div class="card">
                <h3 class="text-sm font-medium text-gray-300 mb-3 flex items-center gap-2">
                  <i class="i-hugeicons-checkmark-circle-02 w-4 h-4 text-emerald-400" />
                  Белый список
                  <span class="text-xs text-gray-500">({players().whitelist.length})</span>
                </h3>
                <Show when={players().whitelist.length === 0}>
                  <p class="text-sm text-gray-500">Пусто — все могут заходить</p>
                </Show>
                <div class="space-y-2 max-h-60 overflow-y-auto">
                  <For each={players().whitelist}>
                    {(player) => (
                      <div class="flex items-center justify-between bg-gray-800/50 rounded-lg px-3 py-2">
                        <span class="text-sm text-gray-300">{player.name}</span>
                        <Tooltip text="Удалить" position="bottom">
                          <button
                            class="text-red-400 hover:text-red-300 p-1"
                            onClick={() => removeFromWhitelist(player.name)}
                          >
                            <i class="i-hugeicons-cancel-01 w-4 h-4" />
                          </button>
                        </Tooltip>
                      </div>
                    )}
                  </For>
                </div>
              </div>

              {/* Operators */}
              <div class="card">
                <h3 class="text-sm font-medium text-gray-300 mb-3 flex items-center gap-2">
                  <i class="i-hugeicons-user-settings-01 w-4 h-4 text-yellow-400" />
                  Операторы
                  <span class="text-xs text-gray-500">({players().ops.length})</span>
                </h3>
                <Show when={players().ops.length === 0}>
                  <p class="text-sm text-gray-500">Нет операторов</p>
                </Show>
                <div class="space-y-2 max-h-60 overflow-y-auto">
                  <For each={players().ops}>
                    {(op) => (
                      <div class="flex items-center justify-between bg-gray-800/50 rounded-lg px-3 py-2">
                        <div class="flex items-center gap-2">
                          <span class="text-sm text-gray-300">{op.name}</span>
                          <span class="text-xs px-1.5 py-0.5 rounded bg-yellow-500/20 text-yellow-400">
                            Ур. {op.level}
                          </span>
                        </div>
                        <Tooltip text="Снять OP" position="bottom">
                          <button
                            class="text-red-400 hover:text-red-300 p-1"
                            onClick={() => removeOperator(op.name)}
                          >
                            <i class="i-hugeicons-cancel-01 w-4 h-4" />
                          </button>
                        </Tooltip>
                      </div>
                    )}
                  </For>
                </div>
              </div>
            </div>

            {/* Banned players */}
            <Show when={players().banned_players.length > 0}>
              <div class="card">
                <h3 class="text-sm font-medium text-gray-300 mb-3 flex items-center gap-2">
                  <i class="i-hugeicons-cancel-circle w-4 h-4 text-red-400" />
                  Заблокированные
                  <span class="text-xs text-gray-500">({players().banned_players.length})</span>
                </h3>
                <div class="space-y-2">
                  <For each={players().banned_players}>
                    {(banned) => (
                      <div class="flex items-center justify-between bg-gray-800/50 rounded-lg px-3 py-2">
                        <div>
                          <span class="text-sm text-gray-300">{banned.name}</span>
                          <p class="text-xs text-gray-500">{banned.reason}</p>
                        </div>
                        <button
                          class="btn-ghost text-xs text-emerald-400"
                          onClick={() => unbanPlayer(banned.name)}
                        >
                          Разбанить
                        </button>
                      </div>
                    )}
                  </For>
                </div>
              </div>
            </Show>
          </div>
        </Show>

        {/* EULA tab */}
        <Show when={!loading() && mainTab() === "eula"}>
          <div class="card max-w-xl">
            <h3 class="text-lg font-medium text-gray-200 mb-4 flex items-center gap-2">
              <i class="i-hugeicons-file-01 w-5 h-5 text-blue-400" />
              Minecraft EULA
            </h3>

            <Show
              when={eulaStatus().accepted}
              fallback={
                <div class="space-y-4">
                  <div class="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-4">
                    <p class="text-sm text-yellow-300">
                      Для запуска сервера необходимо принять лицензионное соглашение Minecraft (EULA).
                    </p>
                  </div>
                  <p class="text-sm text-gray-400">
                    Принимая EULA, вы соглашаетесь с условиями:{" "}
                    <a
                      href="https://aka.ms/MinecraftEULA"
                      target="_blank"
                      rel="noopener"
                      class="text-blue-400 hover:underline"
                    >
                      https://aka.ms/MinecraftEULA
                    </a>
                  </p>
                  <button class="btn-primary" onClick={acceptEula}>
                    <i class="i-hugeicons-checkmark-circle-02 w-4 h-4" />
                    Принять EULA
                  </button>
                </div>
              }
            >
              <div class="flex items-center gap-3 text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 rounded-lg p-4">
                <i class="i-hugeicons-checkmark-circle-02 w-6 h-6" />
                <span class="font-medium">EULA принята</span>
              </div>
            </Show>
          </div>
        </Show>

        {/* P2P Sync tab */}
        <Show when={!loading() && mainTab() === "p2p"}>
          <div class="h-full overflow-y-auto p-1">
            <ServerP2PPanel
              instanceId={props.instanceId}
              instanceName=""
              serverPort={Number(properties()["server-port"]) || 25565}
            />
          </div>
        </Show>
      </div>
    </div>
  );
};

export default ServerSettings;
