import type { DocSection, DocContentItem, CodeReference, FileLink } from "./types";

// ============================================================================
// HELPER FUNCTIONS для создания контента
// ============================================================================

export const p = (text: string): DocContentItem => ({ type: "paragraph", text });
export const h2 = (text: string): DocContentItem => ({ type: "heading", level: 2, text });
export const h3 = (text: string): DocContentItem => ({ type: "heading", level: 3, text });
export const h4 = (text: string): DocContentItem => ({ type: "heading", level: 4, text });
export const ul = (items: string[]): DocContentItem => ({ type: "list", items });
export const ol = (items: string[]): DocContentItem => ({ type: "list", ordered: true, items });
export const code = (language: string, code: string, filename?: string): DocContentItem =>
  ({ type: "code", language, code, filename });
export const codeRef = (refs: CodeReference[]): DocContentItem => ({ type: "codeRef", refs });
export const fileLinks = (links: FileLink[]): DocContentItem => ({ type: "fileLinks", links });
export const table = (headers: string[], rows: string[][]): DocContentItem =>
  ({ type: "table", headers, rows });
export const tip = (variant: "info" | "warning" | "danger" | "success", title: string, text: string): DocContentItem =>
  ({ type: "tip", variant, title, text });
export const kbd = (shortcuts: { keys: string; description: string }[]): DocContentItem =>
  ({ type: "keyboard", shortcuts });
export const cards = (items: { icon: string; title: string; description: string; badge?: string; navigateTo?: { sectionId: string; subsectionId?: string } }[]): DocContentItem =>
  ({ type: "cards", cards: items });
export const steps = (items: { title: string; description: string }[]): DocContentItem =>
  ({ type: "steps", steps: items });
export const divider = (): DocContentItem => ({ type: "divider" });

// ============================================================================
// СЕКЦИИ ДОКУМЕНТАЦИИ
// ============================================================================

export const docSections: DocSection[] = [
  // ========== НАЧАЛО РАБОТЫ ==========
  {
    id: "getting-started",
    titleKey: "docs.sections.gettingStarted.title",
    icon: "i-hugeicons-rocket-01",
    keywords: ["start", "begin", "install", "quick", "первый", "начало", "установка"],
    subsections: [
      {
        id: "welcome",
        titleKey: "docs.sections.gettingStarted.welcome.title",
        content: [
          p("docs.sections.gettingStarted.welcome.intro"),
          cards([
            { icon: "i-hugeicons-cube", title: "docs.sections.gettingStarted.welcome.features.instances", description: "docs.sections.gettingStarted.welcome.features.instancesDesc", navigateTo: { sectionId: "instances", subsectionId: "overview" } },
            { icon: "i-hugeicons-package", title: "docs.sections.gettingStarted.welcome.features.mods", description: "docs.sections.gettingStarted.welcome.features.modsDesc", navigateTo: { sectionId: "mods", subsectionId: "sources" } },
            { icon: "i-hugeicons-hard-drive", title: "docs.sections.gettingStarted.welcome.features.servers", description: "docs.sections.gettingStarted.welcome.features.serversDesc", navigateTo: { sectionId: "servers", subsectionId: "overview" } },
            { icon: "i-hugeicons-wifi-01", title: "docs.sections.gettingStarted.welcome.features.connect", description: "docs.sections.gettingStarted.welcome.features.connectDesc", navigateTo: { sectionId: "connect", subsectionId: "overview" } },
          ]),
        ],
      },
      {
        id: "quick-start",
        titleKey: "docs.sections.gettingStarted.quickStart.title",
        content: [
          p("docs.sections.gettingStarted.quickStart.intro"),
          steps([
            { title: "docs.sections.gettingStarted.quickStart.step1.title", description: "docs.sections.gettingStarted.quickStart.step1.desc" },
            { title: "docs.sections.gettingStarted.quickStart.step2.title", description: "docs.sections.gettingStarted.quickStart.step2.desc" },
            { title: "docs.sections.gettingStarted.quickStart.step3.title", description: "docs.sections.gettingStarted.quickStart.step3.desc" },
            { title: "docs.sections.gettingStarted.quickStart.step4.title", description: "docs.sections.gettingStarted.quickStart.step4.desc" },
          ]),
        ],
      },
      {
        id: "requirements",
        titleKey: "docs.sections.gettingStarted.requirements.title",
        content: [
          tip("info", "docs.sections.gettingStarted.requirements.tipTitle", "docs.sections.gettingStarted.requirements.tipText"),
          table(
            ["docs.sections.gettingStarted.requirements.component", "docs.sections.gettingStarted.requirements.minimum", "docs.sections.gettingStarted.requirements.recommended"],
            [
              ["docs.sections.gettingStarted.requirements.os", "Windows 10 / macOS 10.15 / Linux", "Windows 11 / macOS 14 / Linux"],
              ["RAM", "4 GB", "8+ GB"],
              ["docs.sections.gettingStarted.requirements.disk", "1 GB", "10+ GB"],
              ["Java", "docs.sections.gettingStarted.requirements.javaAuto", "docs.sections.gettingStarted.requirements.javaAuto"],
            ]
          ),
          h3("docs.sections.gettingStarted.requirements.javaTitle"),
          p("docs.sections.gettingStarted.requirements.javaText"),
          table(
            ["Minecraft", "Java"],
            [
              ["1.16 и ниже", "Java 8"],
              ["1.17 - 1.20.4", "Java 17"],
              ["1.20.5+", "Java 21"],
            ]
          ),
        ],
      },
      {
        id: "folders",
        titleKey: "docs.sections.gettingStarted.folders.title",
        content: [
          p("docs.sections.gettingStarted.folders.intro"),
          fileLinks([
            { path: "base", description: "docs.sections.gettingStarted.folders.base", isDirectory: true },
            { path: "instances", description: "docs.sections.gettingStarted.folders.instances", isDirectory: true },
            { path: "java", description: "docs.sections.gettingStarted.folders.java", isDirectory: true },
            { path: "logs", description: "docs.sections.gettingStarted.folders.logs", isDirectory: true },
            { path: "cache", description: "docs.sections.gettingStarted.folders.cache", isDirectory: true },
          ]),
          h3("docs.sections.gettingStarted.folders.globalTitle"),
          fileLinks([
            { path: "resourcepacks", description: "docs.sections.gettingStarted.folders.resourcepacks", isDirectory: true },
            { path: "shaderpacks", description: "docs.sections.gettingStarted.folders.shaderpacks", isDirectory: true },
            { path: "libraries", description: "docs.sections.gettingStarted.folders.libraries", isDirectory: true },
            { path: "assets", description: "docs.sections.gettingStarted.folders.assets", isDirectory: true },
          ]),
        ],
      },
    ],
  },

  // ========== ЭКЗЕМПЛЯРЫ ==========
  {
    id: "instances",
    titleKey: "docs.sections.instances.title",
    icon: "i-hugeicons-cube",
    keywords: ["instance", "экземпляр", "сборка", "modpack", "client", "server", "клиент", "сервер"],
    subsections: [
      {
        id: "overview",
        titleKey: "docs.sections.instances.overview.title",
        content: [
          p("docs.sections.instances.overview.intro"),
          cards([
            { icon: "i-hugeicons-laptop", title: "docs.sections.instances.overview.client.title", description: "docs.sections.instances.overview.client.desc", badge: "Client" },
            { icon: "i-hugeicons-hard-drive", title: "docs.sections.instances.overview.server.title", description: "docs.sections.instances.overview.server.desc", badge: "Server" },
          ]),
        ],
      },
      {
        id: "creating",
        titleKey: "docs.sections.instances.creating.title",
        content: [
          p("docs.sections.instances.creating.intro"),
          steps([
            { title: "docs.sections.instances.creating.step1.title", description: "docs.sections.instances.creating.step1.desc" },
            { title: "docs.sections.instances.creating.step2.title", description: "docs.sections.instances.creating.step2.desc" },
            { title: "docs.sections.instances.creating.step3.title", description: "docs.sections.instances.creating.step3.desc" },
          ]),
          h3("docs.sections.instances.creating.loaders.title"),
          table(
            ["docs.sections.instances.creating.loaders.loader", "docs.sections.instances.creating.loaders.desc", "docs.sections.instances.creating.loaders.versions"],
            [
              ["Fabric", "docs.sections.instances.creating.loaders.fabricDesc", "1.14+"],
              ["Forge", "docs.sections.instances.creating.loaders.forgeDesc", "1.1+"],
              ["NeoForge", "docs.sections.instances.creating.loaders.neoforgeDesc", "1.20.1+"],
              ["Quilt", "docs.sections.instances.creating.loaders.quiltDesc", "1.14+"],
            ]
          ),
          codeRef([
            { path: "src-tauri/src/instances/lifecycle.rs", line: 45, description: "docs.sections.instances.creating.codeRef.lifecycle", language: "rust" },
            { path: "src/features/instances/components/CreateInstanceForm.tsx", line: 1, description: "docs.sections.instances.creating.codeRef.wizard", language: "tsx" },
          ]),
        ],
      },
      {
        id: "structure",
        titleKey: "docs.sections.instances.structure.title",
        content: [
          p("docs.sections.instances.structure.intro"),
          fileLinks([
            { path: "instances", description: "docs.sections.instances.structure.openInstances", isDirectory: true },
          ]),
          h3("docs.sections.instances.structure.foldersTitle"),
          code("text", `instances/
└── MyModpack/
    ├── mods/           # JAR файлы модов
    ├── config/         # Конфигурации модов
    ├── saves/          # Сохранённые миры
    ├── resourcepacks/  # Ресурспаки экземпляра
    ├── shaderpacks/    # Шейдеры экземпляра
    ├── logs/           # Логи Minecraft
    ├── crash-reports/  # Отчёты о вылетах
    └── instance.json   # Метаданные (версия, память, загрузчик)`),
          tip("info", "docs.sections.instances.structure.tipTitle", "docs.sections.instances.structure.tipText"),
          codeRef([
            { path: "src-tauri/src/instances/mod.rs", line: 1, description: "docs.sections.instances.structure.codeRef.module", language: "rust" },
          ]),
        ],
      },
      {
        id: "actions",
        titleKey: "docs.sections.instances.actions.title",
        content: [
          p("docs.sections.instances.actions.intro"),
          table(
            ["docs.sections.instances.actions.action", "docs.sections.instances.actions.desc", "docs.sections.instances.actions.shortcut"],
            [
              ["docs.sections.instances.actions.play", "docs.sections.instances.actions.playDesc", "-"],
              ["docs.sections.instances.actions.edit", "docs.sections.instances.actions.editDesc", "-"],
              ["docs.sections.instances.actions.repair", "docs.sections.instances.actions.repairDesc", "-"],
              ["docs.sections.instances.actions.backup", "docs.sections.instances.actions.backupDesc", "-"],
              ["docs.sections.instances.actions.delete", "docs.sections.instances.actions.deleteDesc", "-"],
            ]
          ),
        ],
      },
      {
        id: "backup",
        titleKey: "docs.sections.instances.backup.title",
        content: [
          p("docs.sections.instances.backup.intro"),
          ul([
            "docs.sections.instances.backup.feature1",
            "docs.sections.instances.backup.feature2",
            "docs.sections.instances.backup.feature3",
            "docs.sections.instances.backup.feature4",
          ]),
          tip("info", "docs.sections.instances.backup.tipTitle", "docs.sections.instances.backup.tipText"),
          codeRef([
            { path: "src-tauri/src/instances/backup.rs", line: 1, description: "docs.sections.instances.backup.codeRef", language: "rust" },
          ]),
        ],
      },
    ],
  },

  // ========== МОДЫ ==========
  {
    id: "mods",
    titleKey: "docs.sections.mods.title",
    icon: "i-hugeicons-package",
    keywords: ["mod", "мод", "modrinth", "curseforge", "install", "установка", "dependency", "зависимость"],
    subsections: [
      {
        id: "sources",
        titleKey: "docs.sections.mods.sources.title",
        content: [
          p("docs.sections.mods.sources.intro"),
          cards([
            { icon: "i-simple-icons-modrinth", title: "Modrinth", description: "docs.sections.mods.sources.modrinth" },
            { icon: "i-simple-icons-curseforge", title: "CurseForge", description: "docs.sections.mods.sources.curseforge" },
          ]),
          h3("docs.sections.mods.sources.rateTitle"),
          table(
            ["API", "docs.sections.mods.sources.limit", "docs.sections.mods.sources.cache"],
            [
              ["Modrinth", "5 req/s", "5 min"],
              ["CurseForge", "2 req/s", "5 min"],
            ]
          ),
          codeRef([
            { path: "src-tauri/src/api/modrinth.rs", line: 1, description: "docs.sections.mods.sources.codeRef.modrinth", language: "rust" },
            { path: "src-tauri/src/api/curseforge.rs", line: 1, description: "docs.sections.mods.sources.codeRef.curseforge", language: "rust" },
          ]),
        ],
      },
      {
        id: "installing",
        titleKey: "docs.sections.mods.installing.title",
        content: [
          p("docs.sections.mods.installing.intro"),
          steps([
            { title: "docs.sections.mods.installing.step1.title", description: "docs.sections.mods.installing.step1.desc" },
            { title: "docs.sections.mods.installing.step2.title", description: "docs.sections.mods.installing.step2.desc" },
            { title: "docs.sections.mods.installing.step3.title", description: "docs.sections.mods.installing.step3.desc" },
          ]),
          tip("success", "docs.sections.mods.installing.tipTitle", "docs.sections.mods.installing.tipText"),
        ],
      },
      {
        id: "dragdrop",
        titleKey: "docs.sections.mods.dragdrop.title",
        content: [
          p("docs.sections.mods.dragdrop.intro"),
          ul([
            "docs.sections.mods.dragdrop.feature1",
            "docs.sections.mods.dragdrop.feature2",
            "docs.sections.mods.dragdrop.feature3",
          ]),
          codeRef([
            { path: "src/features/mods/components/ModsList.tsx", line: 1, description: "docs.sections.mods.dragdrop.codeRef", language: "tsx" },
          ]),
        ],
      },
      {
        id: "management",
        titleKey: "docs.sections.mods.management.title",
        content: [
          p("docs.sections.mods.management.intro"),
          table(
            ["docs.sections.mods.management.action", "docs.sections.mods.management.desc"],
            [
              ["docs.sections.mods.management.toggle", "docs.sections.mods.management.toggleDesc"],
              ["docs.sections.mods.management.update", "docs.sections.mods.management.updateDesc"],
              ["docs.sections.mods.management.remove", "docs.sections.mods.management.removeDesc"],
              ["docs.sections.mods.management.bulk", "docs.sections.mods.management.bulkDesc"],
            ]
          ),
          h3("docs.sections.mods.management.sideTitle"),
          p("docs.sections.mods.management.sideText"),
          table(
            ["docs.sections.mods.management.side", "docs.sections.mods.management.sideDesc"],
            [
              ["client", "docs.sections.mods.management.sideClient"],
              ["server", "docs.sections.mods.management.sideServer"],
              ["both", "docs.sections.mods.management.sideBoth"],
            ]
          ),
          codeRef([
            { path: "src-tauri/src/server/client_mods.rs", line: 1, description: "docs.sections.mods.management.codeRef", language: "rust" },
          ]),
        ],
      },
      {
        id: "dependencies",
        titleKey: "docs.sections.mods.dependencies.title",
        content: [
          p("docs.sections.mods.dependencies.intro"),
          ul([
            "docs.sections.mods.dependencies.feature1",
            "docs.sections.mods.dependencies.feature2",
            "docs.sections.mods.dependencies.feature3",
          ]),
          tip("warning", "docs.sections.mods.dependencies.tipTitle", "docs.sections.mods.dependencies.tipText"),
        ],
      },
    ],
  },

  // ========== MODPACK EDITOR ==========
  {
    id: "modpack-editor",
    titleKey: "docs.sections.modpackEditor.title",
    icon: "i-hugeicons-edit-02",
    keywords: ["modpack", "editor", "редактор", "profile", "профиль", "bulk", "массовые"],
    subsections: [
      {
        id: "overview",
        titleKey: "docs.sections.modpackEditor.overview.title",
        content: [
          p("docs.sections.modpackEditor.overview.intro"),
          cards([
            { icon: "i-hugeicons-package", title: "docs.sections.modpackEditor.overview.mods.title", description: "docs.sections.modpackEditor.overview.mods.desc", navigateTo: { sectionId: "mods", subsectionId: "management" } },
            { icon: "i-hugeicons-settings-02", title: "docs.sections.modpackEditor.overview.configs.title", description: "docs.sections.modpackEditor.overview.configs.desc", navigateTo: { sectionId: "code-editor", subsectionId: "overview" } },
            { icon: "i-hugeicons-folder-01", title: "docs.sections.modpackEditor.overview.files.title", description: "docs.sections.modpackEditor.overview.files.desc", navigateTo: { sectionId: "instances", subsectionId: "structure" } },
            { icon: "i-hugeicons-bookmark-01", title: "docs.sections.modpackEditor.overview.profiles.title", description: "docs.sections.modpackEditor.overview.profiles.desc", navigateTo: { sectionId: "modpack-editor", subsectionId: "profiles" } },
          ]),
        ],
      },
      {
        id: "bulk-operations",
        titleKey: "docs.sections.modpackEditor.bulk.title",
        content: [
          p("docs.sections.modpackEditor.bulk.intro"),
          h3("docs.sections.modpackEditor.bulk.selectTitle"),
          ul([
            "docs.sections.modpackEditor.bulk.select1",
            "docs.sections.modpackEditor.bulk.select2",
            "docs.sections.modpackEditor.bulk.select3",
          ]),
          h3("docs.sections.modpackEditor.bulk.actionsTitle"),
          table(
            ["docs.sections.modpackEditor.bulk.action", "docs.sections.modpackEditor.bulk.desc"],
            [
              ["docs.sections.modpackEditor.bulk.toggleAll", "docs.sections.modpackEditor.bulk.toggleAllDesc"],
              ["docs.sections.modpackEditor.bulk.removeAll", "docs.sections.modpackEditor.bulk.removeAllDesc"],
              ["docs.sections.modpackEditor.bulk.updateAll", "docs.sections.modpackEditor.bulk.updateAllDesc"],
            ]
          ),
          codeRef([
            { path: "src-tauri/src/modpacks/bulk.rs", line: 1, description: "docs.sections.modpackEditor.bulk.codeRef.bulk", language: "rust" },
            { path: "src/shared/hooks/useMultiselect.ts", line: 1, description: "docs.sections.modpackEditor.bulk.codeRef.hook", language: "typescript" },
          ]),
        ],
      },
      {
        id: "profiles",
        titleKey: "docs.sections.modpackEditor.profiles.title",
        content: [
          p("docs.sections.modpackEditor.profiles.intro"),
          steps([
            { title: "docs.sections.modpackEditor.profiles.step1.title", description: "docs.sections.modpackEditor.profiles.step1.desc" },
            { title: "docs.sections.modpackEditor.profiles.step2.title", description: "docs.sections.modpackEditor.profiles.step2.desc" },
            { title: "docs.sections.modpackEditor.profiles.step3.title", description: "docs.sections.modpackEditor.profiles.step3.desc" },
          ]),
          tip("info", "docs.sections.modpackEditor.profiles.tipTitle", "docs.sections.modpackEditor.profiles.tipText"),
          codeRef([
            { path: "src-tauri/src/modpacks/profiles.rs", line: 1, description: "docs.sections.modpackEditor.profiles.codeRef", language: "rust" },
          ]),
        ],
      },
    ],
  },

  // ========== CODE EDITOR ==========
  {
    id: "code-editor",
    titleKey: "docs.sections.codeEditor.title",
    icon: "i-hugeicons-source-code",
    keywords: ["editor", "code", "intellisense", "kubejs", "crafttweaker", "config", "редактор", "код", "highlighting"],
    subsections: [
      {
        id: "overview",
        titleKey: "docs.sections.codeEditor.overview.title",
        content: [
          p("docs.sections.codeEditor.overview.intro"),
          cards([
            { icon: "i-hugeicons-code", title: "docs.sections.codeEditor.overview.highlighting.title", description: "docs.sections.codeEditor.overview.highlighting.desc", navigateTo: { sectionId: "code-editor", subsectionId: "shortcuts" } },
            { icon: "i-hugeicons-magic-wand-01", title: "docs.sections.codeEditor.overview.intellisense.title", description: "docs.sections.codeEditor.overview.intellisense.desc", navigateTo: { sectionId: "code-editor", subsectionId: "intellisense" } },
            { icon: "i-hugeicons-view", title: "docs.sections.codeEditor.overview.preview.title", description: "docs.sections.codeEditor.overview.preview.desc", navigateTo: { sectionId: "code-editor", subsectionId: "recipes" } },
          ]),
          tip("warning", "docs.sections.codeEditor.overview.tipTitle", "docs.sections.codeEditor.overview.tipText"),
        ],
      },
      {
        id: "intellisense",
        titleKey: "docs.sections.codeEditor.intellisense.title",
        content: [
          p("docs.sections.codeEditor.intellisense.intro"),
          h3("docs.sections.codeEditor.intellisense.kubejsTitle"),
          ul([
            "docs.sections.codeEditor.intellisense.kubejs1",
            "docs.sections.codeEditor.intellisense.kubejs2",
            "docs.sections.codeEditor.intellisense.kubejs3",
          ]),
          code("javascript", `// KubeJS пример с автодополнением
ServerEvents.recipes(event => {
  event.shaped('minecraft:diamond', [
    'AAA',
    'ABA',
    'AAA'
  ], {
    A: 'minecraft:coal',
    B: 'minecraft:iron_ingot'
  })
})`, "kubejs/server_scripts/recipes.js"),
          h3("docs.sections.codeEditor.intellisense.minecraftTitle"),
          p("docs.sections.codeEditor.intellisense.minecraftText"),
          codeRef([
            { path: "src-tauri/src/code_editor/minecraft_data/jar_parser.rs", line: 1, description: "docs.sections.codeEditor.intellisense.codeRef.parser", language: "rust" },
          ]),
        ],
      },
      {
        id: "recipes",
        titleKey: "docs.sections.codeEditor.recipes.title",
        content: [
          p("docs.sections.codeEditor.recipes.intro"),
          h3("docs.sections.codeEditor.recipes.supportedTitle"),
          ul([
            "docs.sections.codeEditor.recipes.kubejs",
            "docs.sections.codeEditor.recipes.crafttweaker",
            "docs.sections.codeEditor.recipes.datapack",
          ]),
          tip("success", "docs.sections.codeEditor.recipes.tipTitle", "docs.sections.codeEditor.recipes.tipText"),
        ],
      },
      {
        id: "shortcuts",
        titleKey: "docs.sections.codeEditor.shortcuts.title",
        content: [
          kbd([
            { keys: "Ctrl+Space", description: "docs.sections.codeEditor.shortcuts.autocomplete" },
            { keys: "Ctrl+S", description: "docs.sections.codeEditor.shortcuts.save" },
            { keys: "F11", description: "docs.sections.codeEditor.shortcuts.fullscreen" },
            { keys: "Ctrl+F", description: "docs.sections.codeEditor.shortcuts.search" },
            { keys: "Ctrl+G", description: "docs.sections.codeEditor.shortcuts.goto" },
          ]),
        ],
      },
    ],
  },

  // ========== СЕРВЕРЫ ==========
  {
    id: "servers",
    titleKey: "docs.sections.servers.title",
    icon: "i-hugeicons-hard-drive",
    keywords: ["server", "сервер", "console", "консоль", "rcon", "properties", "import"],
    subsections: [
      {
        id: "overview",
        titleKey: "docs.sections.servers.overview.title",
        content: [
          p("docs.sections.servers.overview.intro"),
          cards([
            { icon: "i-hugeicons-computer-terminal-01", title: "docs.sections.servers.overview.console.title", description: "docs.sections.servers.overview.console.desc", navigateTo: { sectionId: "servers", subsectionId: "console" } },
            { icon: "i-hugeicons-settings-02", title: "docs.sections.servers.overview.properties.title", description: "docs.sections.servers.overview.properties.desc", navigateTo: { sectionId: "servers", subsectionId: "properties" } },
            { icon: "i-hugeicons-user-multiple", title: "docs.sections.servers.overview.players.title", description: "docs.sections.servers.overview.players.desc" },
            { icon: "i-hugeicons-wifi-01", title: "docs.sections.servers.overview.p2p.title", description: "docs.sections.servers.overview.p2p.desc", navigateTo: { sectionId: "connect", subsectionId: "overview" } },
          ]),
        ],
      },
      {
        id: "console",
        titleKey: "docs.sections.servers.console.title",
        content: [
          p("docs.sections.servers.console.intro"),
          h3("docs.sections.servers.console.featuresTitle"),
          ul([
            "docs.sections.servers.console.feature1",
            "docs.sections.servers.console.feature2",
            "docs.sections.servers.console.feature3",
            "docs.sections.servers.console.feature4",
          ]),
          h3("docs.sections.servers.console.colorsTitle"),
          table(
            ["docs.sections.servers.console.level", "docs.sections.servers.console.color"],
            [
              ["INFO", "docs.sections.servers.console.colorGreen"],
              ["WARN", "docs.sections.servers.console.colorYellow"],
              ["ERROR", "docs.sections.servers.console.colorRed"],
            ]
          ),
          codeRef([
            { path: "src-tauri/src/server/console.rs", line: 1, description: "docs.sections.servers.console.codeRef.console", language: "rust" },
            { path: "src/features/instances/components/ServerConsole.tsx", line: 1, description: "docs.sections.servers.console.codeRef.ui", language: "tsx" },
          ]),
        ],
      },
      {
        id: "rcon",
        titleKey: "docs.sections.servers.rcon.title",
        content: [
          p("docs.sections.servers.rcon.intro"),
          table(
            ["docs.sections.servers.rcon.param", "docs.sections.servers.rcon.value"],
            [
              ["docs.sections.servers.rcon.port", "25575"],
              ["docs.sections.servers.rcon.protocol", "Source RCON"],
              ["docs.sections.servers.rcon.auto", "docs.sections.servers.rcon.autoYes"],
            ]
          ),
          tip("info", "docs.sections.servers.rcon.tipTitle", "docs.sections.servers.rcon.tipText"),
          codeRef([
            { path: "src-tauri/src/server/rcon.rs", line: 1, description: "docs.sections.servers.rcon.codeRef", language: "rust" },
          ]),
        ],
      },
      {
        id: "import",
        titleKey: "docs.sections.servers.import.title",
        content: [
          p("docs.sections.servers.import.intro"),
          steps([
            { title: "docs.sections.servers.import.step1.title", description: "docs.sections.servers.import.step1.desc" },
            { title: "docs.sections.servers.import.step2.title", description: "docs.sections.servers.import.step2.desc" },
            { title: "docs.sections.servers.import.step3.title", description: "docs.sections.servers.import.step3.desc" },
          ]),
          h3("docs.sections.servers.import.detectionTitle"),
          p("docs.sections.servers.import.detectionText"),
          codeRef([
            { path: "src-tauri/src/server/import.rs", line: 1, description: "docs.sections.servers.import.codeRef", language: "rust" },
          ]),
        ],
      },
      {
        id: "properties",
        titleKey: "docs.sections.servers.properties.title",
        content: [
          p("docs.sections.servers.properties.intro"),
          ul([
            "docs.sections.servers.properties.feature1",
            "docs.sections.servers.properties.feature2",
            "docs.sections.servers.properties.feature3",
            "docs.sections.servers.properties.feature4",
          ]),
          codeRef([
            { path: "src-tauri/src/server/properties.rs", line: 1, description: "docs.sections.servers.properties.codeRef", language: "rust" },
          ]),
        ],
      },
    ],
  },

  // ========== STUZHIK CONNECT ==========
  {
    id: "connect",
    titleKey: "docs.sections.connect.title",
    icon: "i-hugeicons-wifi-01",
    keywords: ["p2p", "connect", "sync", "синхронизация", "friends", "друзья", "share", "обмен"],
    subsections: [
      {
        id: "overview",
        titleKey: "docs.sections.connect.overview.title",
        content: [
          p("docs.sections.connect.overview.intro"),
          h3("docs.sections.connect.overview.techTitle"),
          table(
            ["docs.sections.connect.overview.component", "docs.sections.connect.overview.value"],
            [
              ["Discovery", "UDP broadcast (19847)"],
              ["Transfer", "TCP (19848)"],
              ["docs.sections.connect.overview.encryption", "X25519 + AES-256-GCM"],
              ["docs.sections.connect.overview.serialization", "MessagePack"],
              ["docs.sections.connect.overview.compression", "zstd"],
            ]
          ),
          tip("success", "docs.sections.connect.overview.tipTitle", "docs.sections.connect.overview.tipText"),
        ],
      },
      {
        id: "privacy",
        titleKey: "docs.sections.connect.privacy.title",
        content: [
          p("docs.sections.connect.privacy.intro"),
          tip("warning", "docs.sections.connect.privacy.tipTitle", "docs.sections.connect.privacy.tipText"),
          table(
            ["docs.sections.connect.privacy.setting", "docs.sections.connect.privacy.default", "docs.sections.connect.privacy.desc"],
            [
              ["enabled", "false", "docs.sections.connect.privacy.enabledDesc"],
              ["visibility", "invisible", "docs.sections.connect.privacy.visibilityDesc"],
              ["show_nickname", "false", "docs.sections.connect.privacy.nicknameDesc"],
              ["show_modpacks", "false", "docs.sections.connect.privacy.modpacksDesc"],
              ["allow_downloads", "nobody", "docs.sections.connect.privacy.downloadsDesc"],
            ]
          ),
          codeRef([
            { path: "src-tauri/src/p2p/settings.rs", line: 1, description: "docs.sections.connect.privacy.codeRef", language: "rust" },
          ]),
        ],
      },
      {
        id: "security",
        titleKey: "docs.sections.connect.security.title",
        content: [
          p("docs.sections.connect.security.intro"),
          h3("docs.sections.connect.security.encryptionTitle"),
          ul([
            "docs.sections.connect.security.encryption1",
            "docs.sections.connect.security.encryption2",
            "docs.sections.connect.security.encryption3",
          ]),
          h3("docs.sections.connect.security.protectionTitle"),
          ul([
            "docs.sections.connect.security.protection1",
            "docs.sections.connect.security.protection2",
            "docs.sections.connect.security.protection3",
            "docs.sections.connect.security.protection4",
          ]),
          codeRef([
            { path: "src-tauri/src/p2p/crypto.rs", line: 1, description: "docs.sections.connect.security.codeRef.crypto", language: "rust" },
            { path: "src-tauri/src/p2p/security.rs", line: 1, description: "docs.sections.connect.security.codeRef.security", language: "rust" },
          ]),
        ],
      },
      {
        id: "network",
        titleKey: "docs.sections.connect.network.title",
        content: [
          p("docs.sections.connect.network.intro"),
          cards([
            { icon: "i-hugeicons-home-wifi", title: "docs.sections.connect.network.local.title", description: "docs.sections.connect.network.local.desc", navigateTo: { sectionId: "connect", subsectionId: "privacy" } },
            { icon: "i-hugeicons-earth", title: "docs.sections.connect.network.vpn.title", description: "docs.sections.connect.network.vpn.desc" },
          ]),
          h3("docs.sections.connect.network.vpnTitle"),
          table(
            ["VPN", "docs.sections.connect.network.difficulty", "docs.sections.connect.network.desc"],
            [
              ["Radmin VPN", "docs.sections.connect.network.easy", "docs.sections.connect.network.radmin"],
              ["ZeroTier", "docs.sections.connect.network.medium", "docs.sections.connect.network.zerotier"],
              ["Tailscale", "docs.sections.connect.network.advanced", "docs.sections.connect.network.tailscale"],
            ]
          ),
          codeRef([
            { path: "src-tauri/src/p2p/network.rs", line: 1, description: "docs.sections.connect.network.codeRef", language: "rust" },
          ]),
        ],
      },
      {
        id: "quick-join",
        titleKey: "docs.sections.connect.quickJoin.title",
        content: [
          p("docs.sections.connect.quickJoin.intro"),
          steps([
            { title: "docs.sections.connect.quickJoin.step1.title", description: "docs.sections.connect.quickJoin.step1.desc" },
            { title: "docs.sections.connect.quickJoin.step2.title", description: "docs.sections.connect.quickJoin.step2.desc" },
            { title: "docs.sections.connect.quickJoin.step3.title", description: "docs.sections.connect.quickJoin.step3.desc" },
          ]),
          code("text", "STUZHIK-XXXX-XXXX", "Формат кода приглашения"),
        ],
      },
    ],
  },

  // ========== TROUBLESHOOTING ==========
  {
    id: "troubleshooting",
    titleKey: "docs.sections.troubleshooting.title",
    icon: "i-hugeicons-wrench-01",
    keywords: ["error", "crash", "fix", "problem", "ошибка", "краш", "проблема", "решение", "faq"],
    subsections: [
      {
        id: "common-issues",
        titleKey: "docs.sections.troubleshooting.common.title",
        content: [
          p("docs.sections.troubleshooting.common.intro"),
          h3("docs.sections.troubleshooting.common.memoryTitle"),
          p("docs.sections.troubleshooting.common.memoryText"),
          ul([
            "docs.sections.troubleshooting.common.memory1",
            "docs.sections.troubleshooting.common.memory2",
            "docs.sections.troubleshooting.common.memory3",
          ]),
          h3("docs.sections.troubleshooting.common.javaTitle"),
          p("docs.sections.troubleshooting.common.javaText"),
          fileLinks([
            { path: "java", description: "docs.sections.troubleshooting.common.openJava", isDirectory: true },
          ]),
          h3("docs.sections.troubleshooting.common.conflictsTitle"),
          p("docs.sections.troubleshooting.common.conflictsText"),
        ],
      },
      {
        id: "log-analyzer",
        titleKey: "docs.sections.troubleshooting.logAnalyzer.title",
        content: [
          p("docs.sections.troubleshooting.logAnalyzer.intro"),
          fileLinks([
            { path: "logs", description: "docs.sections.troubleshooting.logAnalyzer.openLogs", isDirectory: true },
          ]),
          ul([
            "docs.sections.troubleshooting.logAnalyzer.feature1",
            "docs.sections.troubleshooting.logAnalyzer.feature2",
            "docs.sections.troubleshooting.logAnalyzer.feature3",
            "docs.sections.troubleshooting.logAnalyzer.feature4",
          ]),
          tip("info", "docs.sections.troubleshooting.logAnalyzer.tipTitle", "docs.sections.troubleshooting.logAnalyzer.tipText"),
          codeRef([
            { path: "src-tauri/src/log_analyzer/mod.rs", line: 1, description: "docs.sections.troubleshooting.logAnalyzer.codeRef", language: "rust" },
          ]),
        ],
      },
      {
        id: "faq",
        titleKey: "docs.sections.troubleshooting.faq.title",
        content: [
          h3("docs.sections.troubleshooting.faq.q1"),
          p("docs.sections.troubleshooting.faq.a1"),
          h3("docs.sections.troubleshooting.faq.q2"),
          p("docs.sections.troubleshooting.faq.a2"),
          h3("docs.sections.troubleshooting.faq.q3"),
          p("docs.sections.troubleshooting.faq.a3"),
          h3("docs.sections.troubleshooting.faq.q4"),
          p("docs.sections.troubleshooting.faq.a4"),
          h3("docs.sections.troubleshooting.faq.q5"),
          p("docs.sections.troubleshooting.faq.a5"),
        ],
      },
    ],
  },

  // ========== АРХИТЕКТУРА ==========
  {
    id: "architecture",
    titleKey: "docs.sections.architecture.title",
    icon: "i-hugeicons-structure-03",
    keywords: ["architecture", "tauri", "rust", "solidjs", "developer", "архитектура", "разработчик"],
    subsections: [
      {
        id: "stack",
        titleKey: "docs.sections.architecture.stack.title",
        content: [
          p("docs.sections.architecture.stack.intro"),
          cards([
            { icon: "i-hugeicons-code", title: "Frontend", description: "docs.sections.architecture.stack.frontend", navigateTo: { sectionId: "architecture", subsectionId: "structure" } },
            { icon: "i-hugeicons-cpu", title: "Backend", description: "docs.sections.architecture.stack.backend", navigateTo: { sectionId: "architecture", subsectionId: "structure" } },
            { icon: "i-hugeicons-database-01", title: "docs.sections.architecture.stack.database", description: "docs.sections.architecture.stack.databaseDesc" },
          ]),
        ],
      },
      {
        id: "structure",
        titleKey: "docs.sections.architecture.structure.title",
        content: [
          h3("docs.sections.architecture.structure.backendTitle"),
          code("text", `src-tauri/src/
├── api/               # Modrinth, CurseForge + cache
├── instances/         # Управление экземплярами
├── modpacks/          # Модпаки
├── server/            # Серверная логика
├── p2p/               # Stuzhik Connect
├── code_editor/       # Редактор кода
├── smart_downloader/  # Загрузки с зеркалами
├── log_analyzer/      # Анализ логов
└── performance/       # RAM/CPU мониторинг`),
          h3("docs.sections.architecture.structure.frontendTitle"),
          code("text", `src/
├── features/          # instances, mods, modpacks, settings
└── shared/
    ├── components/    # TitleBar, Toast, WebGL
    ├── hooks/         # useSettings, useDownloads
    ├── ui/            # Select, Toggle, Dropdown
    ├── i18n/          # Локализация
    └── types/         # TypeScript типы`),
        ],
      },
      {
        id: "principles",
        titleKey: "docs.sections.architecture.principles.title",
        content: [
          ul([
            "docs.sections.architecture.principles.performance",
            "docs.sections.architecture.principles.security",
            "docs.sections.architecture.principles.responsive",
            "docs.sections.architecture.principles.animations",
          ]),
        ],
      },
    ],
  },

  // ========== ГОРЯЧИЕ КЛАВИШИ ==========
  {
    id: "shortcuts",
    titleKey: "docs.sections.shortcuts.title",
    icon: "i-hugeicons-keyboard",
    keywords: ["keyboard", "shortcut", "hotkey", "клавиатура", "горячие", "клавиши"],
    content: [
      h3("docs.sections.shortcuts.globalTitle"),
      kbd([
        { keys: "Ctrl+Shift+D", description: "docs.sections.shortcuts.devConsole" },
        { keys: "Ctrl+Shift+U", description: "docs.sections.shortcuts.uiKit" },
        { keys: "Ctrl+M", description: "docs.sections.shortcuts.minimize" },
        { keys: "Escape", description: "docs.sections.shortcuts.closeModal" },
      ]),
      h3("docs.sections.shortcuts.consoleTitle"),
      kbd([
        { keys: "↑", description: "docs.sections.shortcuts.prevCommand" },
        { keys: "↓", description: "docs.sections.shortcuts.nextCommand" },
        { keys: "Enter", description: "docs.sections.shortcuts.sendCommand" },
      ]),
      h3("docs.sections.shortcuts.editorTitle"),
      kbd([
        { keys: "Ctrl+S", description: "docs.sections.shortcuts.save" },
        { keys: "Ctrl+Space", description: "docs.sections.shortcuts.autocomplete" },
        { keys: "F11", description: "docs.sections.shortcuts.fullscreen" },
        { keys: "Ctrl+F", description: "docs.sections.shortcuts.search" },
      ]),
      tip("info", "docs.sections.shortcuts.tipTitle", "docs.sections.shortcuts.tipText"),
    ],
  },
];

// ============================================================================
// ФУНКЦИИ ПОИСКА
// ============================================================================

/**
 * Получить все поисковые термины для секции
 */
export function getSectionSearchTerms(section: DocSection): string[] {
  const terms: string[] = [section.titleKey, ...(section.keywords || [])];

  if (section.subsections) {
    for (const sub of section.subsections) {
      terms.push(sub.titleKey);
      for (const item of sub.content) {
        if (item.type === "paragraph" || item.type === "heading") {
          terms.push(item.text);
        }
      }
    }
  }

  if (section.content) {
    for (const item of section.content) {
      if (item.type === "paragraph" || item.type === "heading") {
        terms.push(item.text);
      }
    }
  }

  return terms;
}
