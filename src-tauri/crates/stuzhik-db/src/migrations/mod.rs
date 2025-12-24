//! Database Migration System
//!
//! Versioned migrations with tracking table.
//! Add new migrations to MIGRATIONS array.

use rusqlite::{params, Connection};

/// Migration definition
pub struct Migration {
    /// Unique version number (must be sequential)
    pub version: i32,
    /// Short description
    pub description: &'static str,
    /// SQL to execute
    pub sql: &'static str,
}

/// All migrations in order. Add new migrations at the end.
pub const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        description: "Add installation persistence columns",
        sql: r#"
            ALTER TABLE instances ADD COLUMN installation_step TEXT;
            ALTER TABLE instances ADD COLUMN installation_error TEXT;
        "#,
    },
    Migration {
        version: 2,
        description: "Create crash_history table",
        sql: r#"
            CREATE TABLE IF NOT EXISTS crash_history (
                id TEXT PRIMARY KEY,
                instance_id TEXT NOT NULL,
                crash_time TEXT NOT NULL,
                log_type TEXT NOT NULL,
                problems_json TEXT NOT NULL,
                suspected_mods TEXT,
                minecraft_version TEXT,
                loader_type TEXT,
                loader_version TEXT,
                was_fixed INTEGER DEFAULT 0,
                fix_method TEXT,
                notes TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                FOREIGN KEY (instance_id) REFERENCES instances(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_crash_history_instance ON crash_history(instance_id);
            CREATE INDEX IF NOT EXISTS idx_crash_history_time ON crash_history(crash_time);
        "#,
    },
    Migration {
        version: 3,
        description: "Create solution feedback and ratings tables",
        sql: r#"
            CREATE TABLE IF NOT EXISTS solution_feedback (
                id TEXT PRIMARY KEY,
                problem_signature TEXT NOT NULL,
                solution_id TEXT NOT NULL,
                helped INTEGER NOT NULL,
                applied_at TEXT NOT NULL DEFAULT (datetime('now')),
                notes TEXT,
                instance_id TEXT,
                UNIQUE(problem_signature, solution_id),
                FOREIGN KEY (instance_id) REFERENCES instances(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS solution_ratings (
                solution_id TEXT PRIMARY KEY,
                times_applied INTEGER NOT NULL DEFAULT 0,
                times_helped INTEGER NOT NULL DEFAULT 0,
                success_rate REAL NOT NULL DEFAULT 0.0,
                last_used TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE INDEX IF NOT EXISTS idx_solution_feedback_signature ON solution_feedback(problem_signature);
            CREATE INDEX IF NOT EXISTS idx_solution_feedback_instance ON solution_feedback(instance_id);
            CREATE INDEX IF NOT EXISTS idx_solution_ratings_success ON solution_ratings(success_rate DESC);
        "#,
    },
    Migration {
        version: 4,
        description: "Add backup_enabled column to instances",
        sql: r#"
            ALTER TABLE instances ADD COLUMN backup_enabled INTEGER;
        "#,
    },
    Migration {
        version: 5,
        description: "Create resourcepacks and shaderpacks tables",
        sql: r#"
            -- Resource Packs table
            CREATE TABLE IF NOT EXISTS resourcepacks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                instance_id TEXT,
                is_global INTEGER DEFAULT 0,

                slug TEXT NOT NULL,
                name TEXT NOT NULL,
                version TEXT NOT NULL,
                minecraft_version TEXT,

                source TEXT NOT NULL,
                source_id TEXT,
                project_url TEXT,
                download_url TEXT,

                file_name TEXT NOT NULL,
                file_hash TEXT,
                file_size INTEGER,

                enabled INTEGER DEFAULT 1,
                auto_update INTEGER DEFAULT 1,

                description TEXT,
                author TEXT,
                icon_url TEXT,
                resolution TEXT,

                installed_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,

                FOREIGN KEY(instance_id) REFERENCES instances(id) ON DELETE CASCADE,
                UNIQUE(instance_id, slug),
                UNIQUE(is_global, slug)
            );

            -- Shader Packs table
            CREATE TABLE IF NOT EXISTS shaderpacks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                instance_id TEXT,
                is_global INTEGER DEFAULT 0,

                slug TEXT NOT NULL,
                name TEXT NOT NULL,
                version TEXT NOT NULL,
                minecraft_version TEXT,

                source TEXT NOT NULL,
                source_id TEXT,
                project_url TEXT,
                download_url TEXT,

                file_name TEXT NOT NULL,
                file_hash TEXT,
                file_size INTEGER,

                enabled INTEGER DEFAULT 1,
                auto_update INTEGER DEFAULT 1,

                description TEXT,
                author TEXT,
                icon_url TEXT,
                features TEXT,

                installed_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,

                FOREIGN KEY(instance_id) REFERENCES instances(id) ON DELETE CASCADE,
                UNIQUE(instance_id, slug),
                UNIQUE(is_global, slug)
            );

            -- Indexes for performance
            CREATE INDEX IF NOT EXISTS idx_resourcepacks_instance ON resourcepacks(instance_id);
            CREATE INDEX IF NOT EXISTS idx_resourcepacks_global ON resourcepacks(is_global);
            CREATE INDEX IF NOT EXISTS idx_resourcepacks_slug ON resourcepacks(slug);
            CREATE INDEX IF NOT EXISTS idx_shaderpacks_instance ON shaderpacks(instance_id);
            CREATE INDEX IF NOT EXISTS idx_shaderpacks_global ON shaderpacks(is_global);
            CREATE INDEX IF NOT EXISTS idx_shaderpacks_slug ON shaderpacks(slug);
        "#,
    },
    Migration {
        version: 6,
        description: "Create mod_collections tables",
        sql: r#"
            -- Mod Collections table
            CREATE TABLE IF NOT EXISTS mod_collections (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT,
                color TEXT DEFAULT '#3b82f6',
                icon TEXT DEFAULT '📦',
                is_builtin INTEGER DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            -- Collection Mods junction table
            CREATE TABLE IF NOT EXISTS collection_mods (
                collection_id TEXT NOT NULL,
                mod_slug TEXT NOT NULL,
                mod_name TEXT NOT NULL,
                mod_source TEXT NOT NULL DEFAULT 'modrinth',
                loader_type TEXT,
                added_at TEXT NOT NULL DEFAULT (datetime('now')),
                PRIMARY KEY (collection_id, mod_slug),
                FOREIGN KEY (collection_id) REFERENCES mod_collections(id) ON DELETE CASCADE
            );

            -- Indexes
            CREATE INDEX IF NOT EXISTS idx_collection_mods_collection ON collection_mods(collection_id);
            CREATE INDEX IF NOT EXISTS idx_collection_mods_slug ON collection_mods(mod_slug);
            CREATE INDEX IF NOT EXISTS idx_mod_collections_builtin ON mod_collections(is_builtin);

            -- Insert built-in collections
            INSERT INTO mod_collections (id, name, description, color, icon, is_builtin) VALUES
                ('optimization', 'Optimization', 'Performance and optimization mods', '#22c55e', 'optimization', 1),
                ('tech', 'Tech Mods', 'Technology and automation mods', '#f59e0b', 'tech', 1),
                ('magic', 'Magic Mods', 'Magic and supernatural mods', '#a855f7', 'magic', 1),
                ('adventure', 'Adventure', 'Exploration and adventure mods', '#ef4444', 'adventure', 1),
                ('building', 'Building', 'Decoration and building mods', '#06b6d4', 'building', 1),
                ('qol', 'Quality of Life', 'Convenience and UI improvements', '#84cc16', 'qol', 1);

            -- Populate optimization collection with common mods
            INSERT INTO collection_mods (collection_id, mod_slug, mod_name, mod_source) VALUES
                ('optimization', 'sodium', 'Sodium', 'modrinth'),
                ('optimization', 'lithium', 'Lithium', 'modrinth'),
                ('optimization', 'phosphor', 'Phosphor', 'modrinth'),
                ('optimization', 'ferritecore', 'FerriteCore', 'modrinth'),
                ('optimization', 'starlight', 'Starlight', 'modrinth'),
                ('optimization', 'entityculling', 'Entity Culling', 'modrinth'),
                ('optimization', 'modernfix', 'ModernFix', 'modrinth'),
                ('optimization', 'immediately-fast', 'ImmediatelyFast', 'modrinth');

            -- Populate QoL collection
            INSERT INTO collection_mods (collection_id, mod_slug, mod_name, mod_source) VALUES
                ('qol', 'jei', 'Just Enough Items', 'modrinth'),
                ('qol', 'jade', 'Jade', 'modrinth'),
                ('qol', 'journeymap', 'JourneyMap', 'modrinth'),
                ('qol', 'appleskin', 'AppleSkin', 'modrinth'),
                ('qol', 'mouse-tweaks', 'Mouse Tweaks', 'modrinth'),
                ('qol', 'inventory-profiles-next', 'Inventory Profiles Next', 'modrinth'),
                ('qol', 'controlling', 'Controlling', 'modrinth');
        "#,
    },
    Migration {
        version: 7,
        description: "Fix collection icons from emoji to filenames",
        sql: r#"
            -- Fix builtin collection icons that were using emoji
            UPDATE mod_collections SET icon = 'optimization' WHERE id = 'optimization' AND icon = '⚡';
            UPDATE mod_collections SET icon = 'tech' WHERE id = 'tech' AND icon = '⚙️';
            UPDATE mod_collections SET icon = 'magic' WHERE id = 'magic' AND icon = '✨';
            UPDATE mod_collections SET icon = 'adventure' WHERE id = 'adventure' AND icon = '🗺️';
            UPDATE mod_collections SET icon = 'building' WHERE id = 'building' AND icon = '🏗️';
            UPDATE mod_collections SET icon = 'qol' WHERE id = 'qol' AND icon = '💎';
            -- Fix default icon for user collections
            UPDATE mod_collections SET icon = 'default' WHERE icon = '📦';
        "#,
    },
];

/// Initialize migrations table
fn init_migrations_table(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute(
        r#"
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            description TEXT NOT NULL,
            applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
        "#,
        [],
    )?;
    Ok(())
}

/// Get current schema version (0 if no migrations applied)
fn get_current_version(conn: &Connection) -> rusqlite::Result<i32> {
    let version: i32 = conn
        .query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    Ok(version)
}

/// Check if a column exists in a table
fn column_exists(conn: &Connection, table: &str, column: &str) -> rusqlite::Result<bool> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({})", table))?;
    let columns: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .filter_map(|r| r.ok())
        .collect();
    Ok(columns.contains(&column.to_string()))
}

/// Run all pending migrations
pub fn run_migrations(conn: &Connection) -> rusqlite::Result<()> {
    init_migrations_table(conn)?;

    let current_version = get_current_version(conn)?;
    log::info!("Current schema version: {}", current_version);

    for migration in MIGRATIONS {
        if migration.version <= current_version {
            continue;
        }

        log::info!(
            "Running migration v{}: {}",
            migration.version,
            migration.description
        );

        // Special handling for v1 - check if columns already exist
        // (for databases that were partially migrated)
        if migration.version == 1 {
            let step_exists = column_exists(conn, "instances", "installation_step")?;
            let error_exists = column_exists(conn, "instances", "installation_error")?;

            if !step_exists {
                conn.execute(
                    "ALTER TABLE instances ADD COLUMN installation_step TEXT",
                    [],
                )?;
            }
            if !error_exists {
                conn.execute(
                    "ALTER TABLE instances ADD COLUMN installation_error TEXT",
                    [],
                )?;
            }
        } else {
            // Normal migration - just execute SQL
            conn.execute_batch(migration.sql)?;
        }

        // Record migration as applied
        conn.execute(
            "INSERT INTO schema_migrations (version, description) VALUES (?1, ?2)",
            params![migration.version, migration.description],
        )?;

        log::info!("Migration v{} completed", migration.version);
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_migrations_are_sequential() {
        let mut prev_version = 0;
        for m in MIGRATIONS {
            assert_eq!(
                m.version,
                prev_version + 1,
                "Migration versions must be sequential"
            );
            prev_version = m.version;
        }
    }
}
