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
    Migration {
        version: 8,
        description: "Add dependency_name to mod_dependencies for proper display",
        sql: r#"
            ALTER TABLE mod_dependencies ADD COLUMN dependency_name TEXT;
        "#,
    },
    Migration {
        version: 9,
        description: "Add mods_folder_mtime for smart sync caching",
        sql: r#"
            ALTER TABLE instances ADD COLUMN mods_folder_mtime INTEGER;
        "#,
    },
    Migration {
        version: 10,
        description: "Add enrichment_hash for persistent dependency caching",
        sql: r#"
            ALTER TABLE instances ADD COLUMN enrichment_hash TEXT;
        "#,
    },
    Migration {
        version: 11,
        description: "Add verification_hash for mod verification caching",
        sql: r#"
            ALTER TABLE instances ADD COLUMN verification_hash TEXT;
        "#,
    },
    Migration {
        version: 12,
        description: "Add mod_id column for dependency matching",
        sql: r#"
            ALTER TABLE mods ADD COLUMN mod_id TEXT;
        "#,
    },
    Migration {
        version: 13,
        description: "Add verified_file_hash for incremental mod verification",
        sql: r#"
            ALTER TABLE mods ADD COLUMN verified_file_hash TEXT;
        "#,
    },
    Migration {
        version: 14,
        description: "Add enriched_file_hash for incremental dependency enrichment",
        sql: r#"
            ALTER TABLE mods ADD COLUMN enriched_file_hash TEXT;
        "#,
    },
    Migration {
        version: 15,
        description: "Reset mod caches to fix corrupted data from aggressive matching",
        sql: r#"
            -- Reset all mod verification/enrichment caches to force re-fetch
            -- This is needed because previous version had:
            -- 1. Aggressive partial matching that found WRONG mods (e.g., "catalogue" -> "The Mandela Catalogue")
            -- 2. Fallback using version.name instead of project.title (e.g., "1.6.9 Forge" instead of "Advancement Plaques")
            -- 3. Saving slug as source_id instead of project_id

            -- Clear verification cache for all mods
            UPDATE mods SET verified_file_hash = NULL;

            -- Clear enrichment cache for all mods
            UPDATE mods SET enriched_file_hash = NULL;

            -- Fix mods with corrupted names (names that look like versions)
            -- Pattern: name starts with version number or brackets
            UPDATE mods SET
                name = slug,
                source = 'local',
                source_id = NULL,
                icon_url = NULL
            WHERE name GLOB '[0-9]*'
               OR name GLOB '\[*'
               OR name GLOB 'v[0-9]*'
               OR name GLOB 'forge-*'
               OR name LIKE '%+%'
               OR (LENGTH(name) < 10 AND name GLOB '*[0-9].[0-9]*');

            -- Fix mods with obviously wrong names (contains ":" which is not typical for mod names)
            -- e.g., "The Mandela Catalogue: Alternates" when mod is actually "Catalogue"
            UPDATE mods SET
                source = 'local',
                source_id = NULL,
                icon_url = NULL,
                verified_file_hash = NULL,
                enriched_file_hash = NULL
            WHERE name LIKE '%:%' AND name NOT LIKE '%Minecraft%';

            -- Fix source_id that looks like slug instead of project_id
            -- Project IDs are 8 alphanumeric chars, slugs have dashes/underscores
            UPDATE mods SET
                source = 'local',
                source_id = NULL
            WHERE source = 'modrinth'
              AND source_id IS NOT NULL
              AND (source_id LIKE '%-%' OR source_id LIKE '%\_%' ESCAPE '\');

            -- Clear instance-level caches
            UPDATE instances SET
                mods_folder_mtime = NULL,
                enrichment_hash = NULL,
                verification_hash = NULL;
        "#,
    },
    Migration {
        version: 16,
        description: "Add mod update tracking columns",
        sql: r#"
            -- Add columns for tracking available updates
            ALTER TABLE mods ADD COLUMN latest_version TEXT;
            ALTER TABLE mods ADD COLUMN latest_version_id TEXT;
            ALTER TABLE mods ADD COLUMN update_available INTEGER DEFAULT 0;
            ALTER TABLE mods ADD COLUMN update_checked_at TEXT;

            -- Index for quick filtering of mods with updates
            CREATE INDEX IF NOT EXISTS idx_mods_update_available ON mods(instance_id, update_available);
        "#,
    },
    Migration {
        version: 17,
        description: "Add performance indexes for mods and dependencies",
        sql: r#"
            -- Index for incremental verification cache lookups
            CREATE INDEX IF NOT EXISTS idx_mods_verified_hash ON mods(verified_file_hash);
            CREATE INDEX IF NOT EXISTS idx_mods_enriched_hash ON mods(enriched_file_hash);

            -- Index for dependency resolution
            CREATE INDEX IF NOT EXISTS idx_mod_deps_slug ON mod_dependencies(dependency_slug);
            CREATE INDEX IF NOT EXISTS idx_mod_deps_mod_id ON mod_dependencies(mod_id);

            -- Index for filtering by source
            CREATE INDEX IF NOT EXISTS idx_mods_source ON mods(instance_id, source);

            -- Index for file_hash lookups (used in sync)
            CREATE INDEX IF NOT EXISTS idx_mods_file_hash ON mods(file_hash);
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

/// Repair schema inconsistencies (columns that should exist but don't)
/// This runs ALWAYS, regardless of migration version, to fix broken databases
fn repair_schema(conn: &Connection) -> rusqlite::Result<()> {
    log::info!("Checking schema integrity...");

    // Check mod_dependencies.dependency_name (v8)
    if !column_exists(conn, "mod_dependencies", "dependency_name")? {
        log::warn!("Missing column mod_dependencies.dependency_name - repairing...");
        conn.execute(
            "ALTER TABLE mod_dependencies ADD COLUMN dependency_name TEXT",
            [],
        )?;
        log::info!("Repaired: added mod_dependencies.dependency_name");
    }

    // Check instances.mods_folder_mtime (v9)
    if !column_exists(conn, "instances", "mods_folder_mtime")? {
        log::warn!("Missing column instances.mods_folder_mtime - repairing...");
        conn.execute(
            "ALTER TABLE instances ADD COLUMN mods_folder_mtime INTEGER",
            [],
        )?;
        log::info!("Repaired: added instances.mods_folder_mtime");
    }

    // Check instances.enrichment_hash (v10)
    if !column_exists(conn, "instances", "enrichment_hash")? {
        log::warn!("Missing column instances.enrichment_hash - repairing...");
        conn.execute("ALTER TABLE instances ADD COLUMN enrichment_hash TEXT", [])?;
        log::info!("Repaired: added instances.enrichment_hash");
    }

    // Check instances.verification_hash (v11)
    if !column_exists(conn, "instances", "verification_hash")? {
        log::warn!("Missing column instances.verification_hash - repairing...");
        conn.execute(
            "ALTER TABLE instances ADD COLUMN verification_hash TEXT",
            [],
        )?;
        log::info!("Repaired: added instances.verification_hash");
    }

    // Check mods.mod_id (v12)
    if !column_exists(conn, "mods", "mod_id")? {
        log::warn!("Missing column mods.mod_id - repairing...");
        conn.execute("ALTER TABLE mods ADD COLUMN mod_id TEXT", [])?;
        log::info!("Repaired: added mods.mod_id");
    }

    // Check mods.verified_file_hash (v13) - for incremental verification
    if !column_exists(conn, "mods", "verified_file_hash")? {
        log::warn!("Missing column mods.verified_file_hash - repairing...");
        conn.execute("ALTER TABLE mods ADD COLUMN verified_file_hash TEXT", [])?;
        log::info!("Repaired: added mods.verified_file_hash");
    }

    // Check mods.enriched_file_hash (v14) - for incremental dependency enrichment
    if !column_exists(conn, "mods", "enriched_file_hash")? {
        log::warn!("Missing column mods.enriched_file_hash - repairing...");
        conn.execute("ALTER TABLE mods ADD COLUMN enriched_file_hash TEXT", [])?;
        log::info!("Repaired: added mods.enriched_file_hash");
    }

    // Check mods.latest_version (v16) - for update tracking
    if !column_exists(conn, "mods", "latest_version")? {
        log::warn!("Missing column mods.latest_version - repairing...");
        conn.execute("ALTER TABLE mods ADD COLUMN latest_version TEXT", [])?;
        log::info!("Repaired: added mods.latest_version");
    }

    // Check mods.latest_version_id (v16)
    if !column_exists(conn, "mods", "latest_version_id")? {
        log::warn!("Missing column mods.latest_version_id - repairing...");
        conn.execute("ALTER TABLE mods ADD COLUMN latest_version_id TEXT", [])?;
        log::info!("Repaired: added mods.latest_version_id");
    }

    // Check mods.update_available (v16)
    if !column_exists(conn, "mods", "update_available")? {
        log::warn!("Missing column mods.update_available - repairing...");
        conn.execute(
            "ALTER TABLE mods ADD COLUMN update_available INTEGER DEFAULT 0",
            [],
        )?;
        log::info!("Repaired: added mods.update_available");
    }

    // Check mods.update_checked_at (v16)
    if !column_exists(conn, "mods", "update_checked_at")? {
        log::warn!("Missing column mods.update_checked_at - repairing...");
        conn.execute("ALTER TABLE mods ADD COLUMN update_checked_at TEXT", [])?;
        log::info!("Repaired: added mods.update_checked_at");
    }

    Ok(())
}

/// Run all pending migrations
pub fn run_migrations(conn: &Connection) -> rusqlite::Result<()> {
    init_migrations_table(conn)?;

    // Always run repair first to fix broken databases
    repair_schema(conn)?;

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
        } else if migration.version == 8 {
            // Special handling for v8 - check if dependency_name column exists
            // (might already exist from base schema or failed migration)
            if !column_exists(conn, "mod_dependencies", "dependency_name")? {
                conn.execute(
                    "ALTER TABLE mod_dependencies ADD COLUMN dependency_name TEXT",
                    [],
                )?;
            }
        } else if migration.version == 9 {
            // Special handling for v9 - check if mods_folder_mtime column exists
            if !column_exists(conn, "instances", "mods_folder_mtime")? {
                conn.execute(
                    "ALTER TABLE instances ADD COLUMN mods_folder_mtime INTEGER",
                    [],
                )?;
            }
        } else if migration.version == 10 {
            // Special handling for v10 - check if enrichment_hash column exists
            if !column_exists(conn, "instances", "enrichment_hash")? {
                conn.execute("ALTER TABLE instances ADD COLUMN enrichment_hash TEXT", [])?;
            }
        } else if migration.version == 11 {
            // Special handling for v11 - check if verification_hash column exists
            if !column_exists(conn, "instances", "verification_hash")? {
                conn.execute(
                    "ALTER TABLE instances ADD COLUMN verification_hash TEXT",
                    [],
                )?;
            }
        } else if migration.version == 12 {
            // Special handling for v12 - check if mod_id column exists
            if !column_exists(conn, "mods", "mod_id")? {
                conn.execute("ALTER TABLE mods ADD COLUMN mod_id TEXT", [])?;
            }
        } else if migration.version == 13 {
            // Special handling for v13 - check if verified_file_hash column exists
            if !column_exists(conn, "mods", "verified_file_hash")? {
                conn.execute("ALTER TABLE mods ADD COLUMN verified_file_hash TEXT", [])?;
            }
        } else if migration.version == 14 {
            // Special handling for v14 - check if enriched_file_hash column exists
            if !column_exists(conn, "mods", "enriched_file_hash")? {
                conn.execute("ALTER TABLE mods ADD COLUMN enriched_file_hash TEXT", [])?;
            }
        } else if migration.version == 16 {
            // Special handling for v16 - add update tracking columns if they don't exist
            if !column_exists(conn, "mods", "latest_version")? {
                conn.execute("ALTER TABLE mods ADD COLUMN latest_version TEXT", [])?;
            }
            if !column_exists(conn, "mods", "latest_version_id")? {
                conn.execute("ALTER TABLE mods ADD COLUMN latest_version_id TEXT", [])?;
            }
            if !column_exists(conn, "mods", "update_available")? {
                conn.execute(
                    "ALTER TABLE mods ADD COLUMN update_available INTEGER DEFAULT 0",
                    [],
                )?;
            }
            if !column_exists(conn, "mods", "update_checked_at")? {
                conn.execute("ALTER TABLE mods ADD COLUMN update_checked_at TEXT", [])?;
            }
            // Create index (IF NOT EXISTS handles idempotency)
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_mods_update_available ON mods(instance_id, update_available)",
                [],
            )?;
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
