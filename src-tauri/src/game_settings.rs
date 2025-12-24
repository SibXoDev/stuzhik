use crate::error::{LauncherError, Result};
use crate::instances::get_instance;
use crate::paths::{
    get_base_dir, global_resourcepacks_dir, global_shaderpacks_dir, instance_resourcepacks_dir,
    instance_shaderpacks_dir,
};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Директория для хранения шаблонов настроек
pub fn settings_templates_dir() -> PathBuf {
    get_base_dir().join("settings_templates")
}

/// Копирует настройки игры из одного экземпляра в шаблон
#[tauri::command]
pub async fn save_settings_template(instance_id: String, template_name: String) -> Result<()> {
    let instance = get_instance(instance_id).await?;
    let instance_dir = PathBuf::from(&instance.dir);

    // Создаём директорию шаблона
    let template_dir = settings_templates_dir().join(&template_name);
    tokio::fs::create_dir_all(&template_dir).await?;

    // Копируем options.txt
    let options_file = instance_dir.join("options.txt");
    if tokio::fs::try_exists(&options_file).await.unwrap_or(false) {
        tokio::fs::copy(&options_file, template_dir.join("options.txt")).await?;
    }

    // Копируем optionsof.txt (OptiFine)
    let optionsof_file = instance_dir.join("optionsof.txt");
    if tokio::fs::try_exists(&optionsof_file)
        .await
        .unwrap_or(false)
    {
        tokio::fs::copy(&optionsof_file, template_dir.join("optionsof.txt")).await?;
    }

    // Копируем optionsshaders.txt (Shaders)
    let optionsshaders_file = instance_dir.join("optionsshaders.txt");
    if tokio::fs::try_exists(&optionsshaders_file)
        .await
        .unwrap_or(false)
    {
        tokio::fs::copy(
            &optionsshaders_file,
            template_dir.join("optionsshaders.txt"),
        )
        .await?;
    }

    // Копируем конфиг модов (если есть)
    let config_dir = instance_dir.join("config");
    let template_config_dir = template_dir.join("config");
    if tokio::fs::try_exists(&config_dir).await.unwrap_or(false) {
        copy_dir_recursive(config_dir, template_config_dir).await?;
    }

    log::info!(
        "Settings template '{}' saved from instance {}",
        template_name,
        instance.name
    );
    Ok(())
}

/// Применяет шаблон настроек к экземпляру
#[tauri::command]
pub async fn apply_settings_template(instance_id: String, template_name: String) -> Result<()> {
    let instance = get_instance(instance_id).await?;
    let instance_dir = PathBuf::from(&instance.dir);
    let template_dir = settings_templates_dir().join(&template_name);

    if !tokio::fs::try_exists(&template_dir).await.unwrap_or(false) {
        return Err(LauncherError::InvalidConfig(format!(
            "Settings template '{}' not found",
            template_name
        )));
    }

    // Копируем options.txt
    let options_file = template_dir.join("options.txt");
    if tokio::fs::try_exists(&options_file).await.unwrap_or(false) {
        tokio::fs::copy(&options_file, instance_dir.join("options.txt")).await?;
    }

    // Копируем optionsof.txt
    let optionsof_file = template_dir.join("optionsof.txt");
    if tokio::fs::try_exists(&optionsof_file)
        .await
        .unwrap_or(false)
    {
        tokio::fs::copy(&optionsof_file, instance_dir.join("optionsof.txt")).await?;
    }

    // Копируем optionsshaders.txt
    let optionsshaders_file = template_dir.join("optionsshaders.txt");
    if tokio::fs::try_exists(&optionsshaders_file)
        .await
        .unwrap_or(false)
    {
        tokio::fs::copy(
            &optionsshaders_file,
            instance_dir.join("optionsshaders.txt"),
        )
        .await?;
    }

    // Копируем конфиг модов
    let template_config_dir = template_dir.join("config");
    let instance_config_dir = instance_dir.join("config");
    if tokio::fs::try_exists(&template_config_dir)
        .await
        .unwrap_or(false)
    {
        copy_dir_recursive(template_config_dir, instance_config_dir).await?;
    }

    log::info!(
        "Settings template '{}' applied to instance {}",
        template_name,
        instance.name
    );
    Ok(())
}

/// Список доступных шаблонов настроек
#[tauri::command]
pub async fn list_settings_templates() -> Result<Vec<String>> {
    let templates_dir = settings_templates_dir();

    if !tokio::fs::try_exists(&templates_dir).await.unwrap_or(false) {
        tokio::fs::create_dir_all(&templates_dir).await?;
        return Ok(vec![]);
    }

    let mut templates = vec![];
    let mut entries = tokio::fs::read_dir(&templates_dir).await?;

    while let Some(entry) = entries.next_entry().await? {
        if entry.file_type().await?.is_dir() {
            if let Some(name) = entry.file_name().to_str() {
                templates.push(name.to_string());
            }
        }
    }

    Ok(templates)
}

/// Удаляет шаблон настроек
#[tauri::command]
pub async fn delete_settings_template(template_name: String) -> Result<()> {
    let template_dir = settings_templates_dir().join(&template_name);

    if tokio::fs::try_exists(&template_dir).await.unwrap_or(false) {
        tokio::fs::remove_dir_all(&template_dir).await?;
        log::info!("Settings template '{}' deleted", template_name);
    }

    Ok(())
}

/// Рекурсивное копирование директории
fn copy_dir_recursive(
    src: PathBuf,
    dst: PathBuf,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>> + Send>> {
    Box::pin(async move {
        if !tokio::fs::try_exists(&dst).await.unwrap_or(false) {
            tokio::fs::create_dir_all(&dst).await?;
        }

        let mut entries = tokio::fs::read_dir(&src).await?;

        while let Some(entry) = entries.next_entry().await? {
            let file_type = entry.file_type().await?;
            let src_path = entry.path();
            let dst_path = dst.join(entry.file_name());

            if file_type.is_dir() {
                copy_dir_recursive(src_path, dst_path).await?;
            } else {
                tokio::fs::copy(&src_path, &dst_path).await?;
            }
        }

        Ok(())
    })
}

// ============================================================================
// Глобальные Resourcepacks и Shaderpacks
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PackInfo {
    pub name: String,
    pub size: u64,
    pub modified: String,
}

/// Список глобальных resourcepacks
#[tauri::command]
pub async fn list_global_resourcepacks() -> Result<Vec<PackInfo>> {
    list_packs_in_dir(global_resourcepacks_dir()).await
}

/// Список глобальных shaderpacks
#[tauri::command]
pub async fn list_global_shaderpacks() -> Result<Vec<PackInfo>> {
    list_packs_in_dir(global_shaderpacks_dir()).await
}

/// Вспомогательная функция для получения списка пакетов
async fn list_packs_in_dir(dir: PathBuf) -> Result<Vec<PackInfo>> {
    if !tokio::fs::try_exists(&dir).await.unwrap_or(false) {
        tokio::fs::create_dir_all(&dir).await?;
        return Ok(vec![]);
    }

    let mut packs = vec![];
    let mut entries = tokio::fs::read_dir(&dir).await?;

    while let Some(entry) = entries.next_entry().await? {
        let metadata = entry.metadata().await?;
        let name = entry.file_name().to_string_lossy().to_string();

        // Фильтруем только .zip файлы и директории
        if metadata.is_file() && !name.ends_with(".zip") {
            continue;
        }

        let modified = metadata
            .modified()
            .ok()
            .and_then(|t| {
                chrono::DateTime::<chrono::Utc>::from(t)
                    .format("%Y-%m-%d %H:%M:%S")
                    .to_string()
                    .into()
            })
            .unwrap_or_default();

        packs.push(PackInfo {
            name,
            size: metadata.len(),
            modified,
        });
    }

    Ok(packs)
}

/// Копирует глобальные resourcepacks в экземпляр
#[tauri::command]
pub async fn copy_global_resourcepacks_to_instance(
    instance_id: String,
    pack_names: Vec<String>,
) -> Result<()> {
    let global_dir = global_resourcepacks_dir();
    let instance_dir = instance_resourcepacks_dir(&instance_id);

    tokio::fs::create_dir_all(&instance_dir).await?;

    for pack_name in pack_names {
        let src = global_dir.join(&pack_name);
        let dst = instance_dir.join(&pack_name);

        if tokio::fs::try_exists(&src).await.unwrap_or(false) {
            let is_dir = tokio::fs::metadata(&src)
                .await
                .map(|m| m.is_dir())
                .unwrap_or(false);
            if is_dir {
                copy_dir_recursive(src, dst).await?;
            } else {
                tokio::fs::copy(&src, &dst).await?;
            }
        }
    }

    Ok(())
}

/// Копирует глобальные shaderpacks в экземпляр
#[tauri::command]
pub async fn copy_global_shaderpacks_to_instance(
    instance_id: String,
    pack_names: Vec<String>,
) -> Result<()> {
    let global_dir = global_shaderpacks_dir();
    let instance_dir = instance_shaderpacks_dir(&instance_id);

    tokio::fs::create_dir_all(&instance_dir).await?;

    for pack_name in pack_names {
        let src = global_dir.join(&pack_name);
        let dst = instance_dir.join(&pack_name);

        if tokio::fs::try_exists(&src).await.unwrap_or(false) {
            let is_dir = tokio::fs::metadata(&src)
                .await
                .map(|m| m.is_dir())
                .unwrap_or(false);
            if is_dir {
                copy_dir_recursive(src, dst).await?;
            } else {
                tokio::fs::copy(&src, &dst).await?;
            }
        }
    }

    Ok(())
}

/// Удаляет глобальный resourcepack
#[tauri::command]
pub async fn delete_global_resourcepack(pack_name: String) -> Result<()> {
    let pack_path = global_resourcepacks_dir().join(&pack_name);

    if tokio::fs::try_exists(&pack_path).await.unwrap_or(false) {
        let is_dir = tokio::fs::metadata(&pack_path)
            .await
            .map(|m| m.is_dir())
            .unwrap_or(false);
        if is_dir {
            tokio::fs::remove_dir_all(&pack_path).await?;
        } else {
            tokio::fs::remove_file(&pack_path).await?;
        }
    }

    Ok(())
}

/// Удаляет глобальный shaderpack
#[tauri::command]
pub async fn delete_global_shaderpack(pack_name: String) -> Result<()> {
    let pack_path = global_shaderpacks_dir().join(&pack_name);

    if tokio::fs::try_exists(&pack_path).await.unwrap_or(false) {
        let is_dir = tokio::fs::metadata(&pack_path)
            .await
            .map(|m| m.is_dir())
            .unwrap_or(false);
        if is_dir {
            tokio::fs::remove_dir_all(&pack_path).await?;
        } else {
            tokio::fs::remove_file(&pack_path).await?;
        }
    }

    Ok(())
}

/// Открывает директорию с глобальными resourcepacks в проводнике
#[tauri::command]
pub async fn open_global_resourcepacks_folder() -> Result<String> {
    let dir = global_resourcepacks_dir();
    tokio::fs::create_dir_all(&dir).await?;
    Ok(dir.to_string_lossy().to_string())
}

/// Открывает директорию с глобальными shaderpacks в проводнике
#[tauri::command]
pub async fn open_global_shaderpacks_folder() -> Result<String> {
    let dir = global_shaderpacks_dir();
    tokio::fs::create_dir_all(&dir).await?;
    Ok(dir.to_string_lossy().to_string())
}
