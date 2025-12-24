use rusqlite::Connection;
use std::sync::OnceLock;

use crate::migrations;

pub static DB_PATH: OnceLock<String> = OnceLock::new();

pub fn init_db(db_path: &str) -> rusqlite::Result<()> {
    let conn = Connection::open(db_path)?;
    // Включаем foreign key constraints
    conn.execute("PRAGMA foreign_keys = ON", [])?;
    conn.execute_batch(
        r#"
        -- Таблица настроек (НОВОЕ)
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        -- Основная таблица экземпляров
        CREATE TABLE IF NOT EXISTS instances (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            version TEXT NOT NULL,              -- minecraft version (1.20.1, 1.19.4, etc)
            loader TEXT NOT NULL,               -- vanilla/forge/neoforge/fabric/quilt
            loader_version TEXT,                -- версия загрузчика (опционально)
            instance_type TEXT NOT NULL,        -- client/server

            -- Java & Launch
            java_version TEXT,                  -- требуемая версия Java (8, 17, 21, etc)
            java_path TEXT,                     -- кастомный путь к Java (если null - автоматический)
            memory_min INTEGER NOT NULL DEFAULT 2048,
            memory_max INTEGER NOT NULL DEFAULT 4096,
            java_args TEXT,                     -- дополнительные JVM аргументы
            game_args TEXT,                     -- дополнительные игровые аргументы

            -- Paths (относительно base_dir)
            dir TEXT NOT NULL UNIQUE,           -- полный путь к директории экземпляра

            -- Server specific
            port INTEGER,
            rcon_enabled INTEGER DEFAULT 0,
            rcon_port INTEGER,
            rcon_password TEXT,

            -- Client specific
            username TEXT,                      -- ОПЦИОНАЛЬНЫЙ (если NULL используем глобальный)

            -- Status & Settings
            status TEXT NOT NULL DEFAULT 'stopped',
            pid INTEGER,                        -- Process ID (NULL если остановлен)
            auto_restart INTEGER DEFAULT 0,
            last_played TEXT,                   -- последний запуск
            total_playtime INTEGER DEFAULT 0,   -- общее время игры в секундах
            notes TEXT,

            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        -- Таблица модов
        CREATE TABLE IF NOT EXISTS mods (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            instance_id TEXT NOT NULL,

            -- Идентификация
            slug TEXT NOT NULL,                 -- уникальный slug (fabric-api, jei, sodium, etc)
            name TEXT NOT NULL,
            version TEXT NOT NULL,
            minecraft_version TEXT NOT NULL,    -- для какой версии MC этот мод

            -- Источник
            source TEXT NOT NULL,               -- modrinth/curseforge/local
            source_id TEXT,                     -- ID мода на платформе
            project_url TEXT,                   -- ссылка на страницу проекта
            download_url TEXT,                  -- прямая ссылка на файл

            -- Файл
            file_name TEXT NOT NULL,            -- имя файла (example-mod-1.0.0.jar)
            file_hash TEXT,                     -- SHA1/SHA256 хеш для верификации
            file_size INTEGER,                  -- размер файла в байтах

            -- Состояние
            enabled INTEGER DEFAULT 1,
            auto_update INTEGER DEFAULT 1,      -- автообновление включено

            -- Метаданные
            description TEXT,
            author TEXT,
            icon_url TEXT,
            categories TEXT,                    -- JSON массив категорий

            -- Timestamps
            installed_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,

            FOREIGN KEY(instance_id) REFERENCES instances(id) ON DELETE CASCADE,
            UNIQUE(instance_id, slug)
        );

        -- Зависимости модов
        CREATE TABLE IF NOT EXISTS mod_dependencies (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            mod_id INTEGER NOT NULL,
            dependency_slug TEXT NOT NULL,
            dependency_type TEXT NOT NULL,      -- required/optional/incompatible
            version_requirement TEXT,           -- например: ">=1.0.0", "[1.0.0,2.0.0)"

            FOREIGN KEY(mod_id) REFERENCES mods(id) ON DELETE CASCADE
        );

        -- История обновлений модов
        CREATE TABLE IF NOT EXISTS mod_update_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            mod_id INTEGER NOT NULL,
            old_version TEXT NOT NULL,
            new_version TEXT NOT NULL,
            updated_at TEXT NOT NULL,

            FOREIGN KEY(mod_id) REFERENCES mods(id) ON DELETE CASCADE
        );

        -- Библиотеки (для продвинутой кастомизации)
        CREATE TABLE IF NOT EXISTS libraries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            instance_id TEXT NOT NULL,
            name TEXT NOT NULL,                 -- maven координаты (org.lwjgl:lwjgl:3.3.1)
            path TEXT NOT NULL,                 -- относительный путь в /shared/libraries
            url TEXT,                           -- URL для скачивания
            sha1 TEXT,                          -- SHA1 хеш
            enabled INTEGER DEFAULT 1,

            FOREIGN KEY(instance_id) REFERENCES instances(id) ON DELETE CASCADE
        );

        -- Версии Java (установленные/доступные)
        CREATE TABLE IF NOT EXISTS java_installations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            version TEXT NOT NULL UNIQUE,       -- 8, 17, 21
            path TEXT NOT NULL,                 -- путь к java executable
            vendor TEXT,                        -- Adoptium, Oracle, etc
            architecture TEXT,                  -- x64, arm64
            is_auto_installed INTEGER DEFAULT 0,
            installed_at TEXT NOT NULL
        );

        -- Версии Minecraft (кеш манифеста)
        CREATE TABLE IF NOT EXISTS minecraft_versions (
            id TEXT PRIMARY KEY,                -- version id (1.20.1, 1.19.4, etc)
            type TEXT NOT NULL,                 -- release/snapshot/old_beta/old_alpha
            release_time TEXT NOT NULL,
            url TEXT NOT NULL,                  -- URL к version.json
            java_version INTEGER NOT NULL,      -- требуемая мажорная версия Java
            cached_at TEXT NOT NULL
        );

        -- Кеш загрузчиков (Forge, NeoForge, Fabric, Quilt)
        CREATE TABLE IF NOT EXISTS loader_versions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            loader TEXT NOT NULL,               -- forge/neoforge/fabric/quilt
            minecraft_version TEXT NOT NULL,
            loader_version TEXT NOT NULL,
            stable INTEGER DEFAULT 1,
            url TEXT,
            cached_at TEXT NOT NULL,

            UNIQUE(loader, minecraft_version, loader_version)
        );

        -- Индексы для производительности
        CREATE INDEX IF NOT EXISTS idx_mods_instance ON mods(instance_id);
        CREATE INDEX IF NOT EXISTS idx_mods_slug ON mods(slug);
        CREATE INDEX IF NOT EXISTS idx_mods_source ON mods(source, source_id);
        CREATE INDEX IF NOT EXISTS idx_mod_deps_mod ON mod_dependencies(mod_id);
        CREATE INDEX IF NOT EXISTS idx_libraries_instance ON libraries(instance_id);
        CREATE INDEX IF NOT EXISTS idx_loader_versions ON loader_versions(loader, minecraft_version);
        CREATE INDEX IF NOT EXISTS idx_settings_key ON settings(key);

        -- Проекты модпаков (редактор)
        CREATE TABLE IF NOT EXISTS modpack_projects (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            version TEXT DEFAULT '1.0.0',
            minecraft_version TEXT NOT NULL,
            loader TEXT NOT NULL,
            loader_version TEXT,
            author TEXT,
            description TEXT,
            icon_path TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        -- Моды в проекте модпака
        CREATE TABLE IF NOT EXISTS modpack_project_mods (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id TEXT NOT NULL,
            mod_id TEXT NOT NULL,
            slug TEXT NOT NULL,
            name TEXT NOT NULL,
            version TEXT,
            filename TEXT,
            sha256 TEXT,
            size INTEGER,
            source TEXT NOT NULL,
            source_id TEXT,
            source_version_id TEXT,
            download_url TEXT,
            icon_url TEXT,
            required INTEGER DEFAULT 1,
            side TEXT DEFAULT 'both',
            sort_order INTEGER DEFAULT 0,
            created_at TEXT NOT NULL,
            FOREIGN KEY (project_id) REFERENCES modpack_projects(id) ON DELETE CASCADE,
            UNIQUE(project_id, mod_id)
        );

        -- Опциональные группы модов
        CREATE TABLE IF NOT EXISTS modpack_optional_groups (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            name TEXT NOT NULL,
            description TEXT,
            selection_type TEXT DEFAULT 'multiple',
            sort_order INTEGER DEFAULT 0,
            FOREIGN KEY (project_id) REFERENCES modpack_projects(id) ON DELETE CASCADE
        );

        -- Назначения модов в опциональные группы
        CREATE TABLE IF NOT EXISTS modpack_optional_assignments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id TEXT NOT NULL,
            mod_id TEXT NOT NULL,
            default_enabled INTEGER DEFAULT 0,
            note TEXT,
            conflicts_with TEXT,
            FOREIGN KEY (group_id) REFERENCES modpack_optional_groups(id) ON DELETE CASCADE,
            UNIQUE(group_id, mod_id)
        );

        -- Оверрайды проекта модпака
        CREATE TABLE IF NOT EXISTS modpack_overrides (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id TEXT NOT NULL,
            source_path TEXT NOT NULL,
            dest_path TEXT NOT NULL,
            file_hash TEXT,
            file_size INTEGER,
            FOREIGN KEY (project_id) REFERENCES modpack_projects(id) ON DELETE CASCADE,
            UNIQUE(project_id, dest_path)
        );

        -- Индексы для модпак-редактора
        CREATE INDEX IF NOT EXISTS idx_project_mods_project ON modpack_project_mods(project_id);
        CREATE INDEX IF NOT EXISTS idx_project_mods_slug ON modpack_project_mods(slug);
        CREATE INDEX IF NOT EXISTS idx_optional_groups_project ON modpack_optional_groups(project_id);
        CREATE INDEX IF NOT EXISTS idx_optional_assignments_group ON modpack_optional_assignments(group_id);
        CREATE INDEX IF NOT EXISTS idx_overrides_project ON modpack_overrides(project_id);
        "#,
    )?;

    // Run versioned migrations
    migrations::run_migrations(&conn)?;

    Ok(())
}

pub fn get_db_conn() -> rusqlite::Result<Connection> {
    let db_path = DB_PATH.get().expect("DB path not initialized");
    let conn = Connection::open(db_path)?;
    // Включаем foreign key constraints для корректной работы CASCADE DELETE
    conn.execute("PRAGMA foreign_keys = ON", [])?;
    Ok(conn)
}
