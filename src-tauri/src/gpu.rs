//! Модуль для определения и управления GPU устройствами
//!
//! Позволяет:
//! - Обнаруживать доступные GPU (дискретные и интегрированные)
//! - Выбирать предпочтительный GPU для запуска игры
//! - Генерировать переменные окружения для принудительного использования GPU

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::process::Command;

/// Тип GPU устройства
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum GpuType {
    /// Дискретная видеокарта (NVIDIA, AMD)
    Discrete,
    /// Интегрированная графика (Intel HD, AMD APU)
    Integrated,
    /// Неизвестный тип
    Unknown,
}

/// Информация о GPU устройстве
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GpuDevice {
    /// Уникальный идентификатор (индекс или ID)
    pub id: String,
    /// Название устройства
    pub name: String,
    /// Производитель (NVIDIA, AMD, Intel)
    pub vendor: String,
    /// Тип GPU
    pub gpu_type: GpuType,
    /// Рекомендуется ли использовать (дискретные GPU рекомендуются)
    pub recommended: bool,
}

/// Результат обнаружения GPU
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GpuDetectionResult {
    /// Список обнаруженных GPU
    pub devices: Vec<GpuDevice>,
    /// Рекомендуемый GPU (обычно дискретный)
    pub recommended_id: Option<String>,
    /// Есть ли несколько GPU (гибридная графика)
    pub has_multiple_gpus: bool,
    /// Платформа (windows/linux/macos)
    pub platform: String,
}

/// Обнаружить доступные GPU устройства
pub fn detect_gpus() -> GpuDetectionResult {
    let platform = if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "unknown"
    };

    let devices = match platform {
        "windows" => detect_gpus_windows(),
        "linux" => detect_gpus_linux(),
        "macos" => detect_gpus_macos(),
        _ => vec![],
    };

    let has_multiple_gpus = devices.len() > 1;

    // Рекомендуем первый дискретный GPU, иначе первый в списке
    let recommended_id = devices
        .iter()
        .find(|d| d.gpu_type == GpuType::Discrete)
        .or_else(|| devices.first())
        .map(|d| d.id.clone());

    GpuDetectionResult {
        devices,
        recommended_id,
        has_multiple_gpus,
        platform: platform.to_string(),
    }
}

/// Обнаружение GPU на Windows через WMIC
fn detect_gpus_windows() -> Vec<GpuDevice> {
    #[cfg(target_os = "windows")]
    use std::os::windows::process::CommandExt;
    #[cfg(target_os = "windows")]
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let mut devices = Vec::new();

    // Используем WMIC для получения информации о видеокартах
    #[cfg(target_os = "windows")]
    let output = Command::new("wmic")
        .args([
            "path",
            "win32_VideoController",
            "get",
            "Name,AdapterCompatibility",
            "/format:csv",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output();

    #[cfg(not(target_os = "windows"))]
    let output: Result<std::process::Output, std::io::Error> = Err(std::io::Error::new(
        std::io::ErrorKind::Other,
        "Windows only",
    ));

    if let Ok(output) = output {
        let stdout = String::from_utf8_lossy(&output.stdout);

        for (idx, line) in stdout.lines().skip(1).enumerate() {
            let parts: Vec<&str> = line.split(',').collect();
            if parts.len() >= 3 {
                let vendor = parts[1].trim().to_string();
                let name = parts[2].trim().to_string();

                if name.is_empty() {
                    continue;
                }

                let gpu_type = classify_gpu(&vendor, &name);
                let recommended = gpu_type == GpuType::Discrete;

                devices.push(GpuDevice {
                    id: idx.to_string(),
                    name: name.clone(),
                    vendor: vendor.clone(),
                    gpu_type,
                    recommended,
                });
            }
        }
    }

    // Fallback: попробуем через PowerShell если WMIC не сработал
    if devices.is_empty() {
        #[cfg(target_os = "windows")]
        let ps_output = Command::new("powershell")
            .args(["-Command", "Get-WmiObject Win32_VideoController | Select-Object Name, AdapterCompatibility | ConvertTo-Csv -NoTypeInformation"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();

        #[cfg(not(target_os = "windows"))]
        let ps_output: Result<std::process::Output, std::io::Error> = Err(std::io::Error::new(
            std::io::ErrorKind::Other,
            "Windows only",
        ));

        if let Ok(output) = ps_output {
            let stdout = String::from_utf8_lossy(&output.stdout);
            for (idx, line) in stdout.lines().skip(1).enumerate() {
                // Парсим CSV формат "Name","Vendor"
                let clean_line = line.replace('"', "");
                let parts: Vec<&str> = clean_line.split(',').collect();
                if parts.len() >= 2 {
                    let name = parts[0].trim().to_string();
                    let vendor = parts
                        .get(1)
                        .map(|s| s.trim().to_string())
                        .unwrap_or_default();

                    if name.is_empty() {
                        continue;
                    }

                    let gpu_type = classify_gpu(&vendor, &name);
                    let recommended = gpu_type == GpuType::Discrete;

                    devices.push(GpuDevice {
                        id: idx.to_string(),
                        name,
                        vendor,
                        gpu_type,
                        recommended,
                    });
                }
            }
        }
    }

    devices
}

/// Обнаружение GPU на Linux через lspci
fn detect_gpus_linux() -> Vec<GpuDevice> {
    let mut devices = Vec::new();

    // lspci -nn | grep -i vga
    let output = Command::new("lspci").args(["-nn"]).output();

    if let Ok(output) = output {
        let stdout = String::from_utf8_lossy(&output.stdout);

        for (idx, line) in stdout.lines().enumerate() {
            let line_lower = line.to_lowercase();

            // Ищем VGA-совместимые контроллеры и 3D контроллеры
            if line_lower.contains("vga")
                || line_lower.contains("3d controller")
                || line_lower.contains("display")
            {
                let name = extract_gpu_name_from_lspci(line);
                let vendor = detect_vendor(&name);
                let gpu_type = classify_gpu(&vendor, &name);
                let recommended = gpu_type == GpuType::Discrete;

                devices.push(GpuDevice {
                    id: idx.to_string(),
                    name,
                    vendor,
                    gpu_type,
                    recommended,
                });
            }
        }
    }

    // Также проверим /sys/class/drm для более детальной информации
    if devices.is_empty() {
        if let Ok(entries) = std::fs::read_dir("/sys/class/drm") {
            for (_idx, entry) in entries.filter_map(|e| e.ok()).enumerate() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with("card") && !name.contains('-') {
                    // Пытаемся прочитать название устройства
                    let device_path = entry.path().join("device/vendor");
                    let vendor_id = std::fs::read_to_string(&device_path)
                        .ok()
                        .map(|s| s.trim().to_string())
                        .unwrap_or_default();

                    let vendor = match vendor_id.as_str() {
                        "0x10de" => "NVIDIA",
                        "0x1002" => "AMD",
                        "0x8086" => "Intel",
                        _ => "Unknown",
                    };

                    let gpu_type = if vendor == "Intel" {
                        GpuType::Integrated
                    } else {
                        GpuType::Discrete
                    };

                    devices.push(GpuDevice {
                        id: name.clone(),
                        name: format!("{} GPU ({})", vendor, name),
                        vendor: vendor.to_string(),
                        gpu_type: gpu_type.clone(),
                        recommended: gpu_type == GpuType::Discrete,
                    });
                }
            }
        }
    }

    devices
}

/// Обнаружение GPU на macOS через system_profiler
fn detect_gpus_macos() -> Vec<GpuDevice> {
    let mut devices = Vec::new();

    let output = Command::new("system_profiler")
        .args(["SPDisplaysDataType", "-json"])
        .output();

    if let Ok(output) = output {
        let stdout = String::from_utf8_lossy(&output.stdout);

        // Простой парсинг JSON (без serde_json для минимизации зависимостей)
        // Ищем "sppci_model" или "spdisplays_device-id"
        for (idx, line) in stdout.lines().enumerate() {
            if line.contains("sppci_model") || line.contains("chipset_model") {
                // Извлекаем значение после ":"
                if let Some(value) = line.split(':').nth(1) {
                    let name = value.trim().trim_matches('"').trim_matches(',').to_string();
                    if !name.is_empty() {
                        let vendor = detect_vendor(&name);
                        let gpu_type = classify_gpu(&vendor, &name);

                        devices.push(GpuDevice {
                            id: idx.to_string(),
                            name: name.clone(),
                            vendor,
                            gpu_type: gpu_type.clone(),
                            recommended: gpu_type == GpuType::Discrete,
                        });
                    }
                }
            }
        }
    }

    // Fallback без JSON
    if devices.is_empty() {
        if let Ok(output) = Command::new("system_profiler")
            .args(["SPDisplaysDataType"])
            .output()
        {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let mut current_name = String::new();

            for line in stdout.lines() {
                let trimmed = line.trim();
                if trimmed.starts_with("Chipset Model:") {
                    current_name = trimmed.replace("Chipset Model:", "").trim().to_string();
                } else if trimmed.ends_with(':') && !current_name.is_empty() {
                    let vendor = detect_vendor(&current_name);
                    let gpu_type = classify_gpu(&vendor, &current_name);

                    devices.push(GpuDevice {
                        id: devices.len().to_string(),
                        name: current_name.clone(),
                        vendor,
                        gpu_type: gpu_type.clone(),
                        recommended: gpu_type == GpuType::Discrete,
                    });
                    current_name.clear();
                }
            }

            // Добавляем последний если есть
            if !current_name.is_empty() {
                let vendor = detect_vendor(&current_name);
                let gpu_type = classify_gpu(&vendor, &current_name);

                devices.push(GpuDevice {
                    id: devices.len().to_string(),
                    name: current_name,
                    vendor,
                    gpu_type: gpu_type.clone(),
                    recommended: gpu_type == GpuType::Discrete,
                });
            }
        }
    }

    devices
}

/// Извлечь название GPU из строки lspci
fn extract_gpu_name_from_lspci(line: &str) -> String {
    // Формат: "00:02.0 VGA compatible controller: Intel Corporation ..."
    if let Some(pos) = line.find(':') {
        let after_type = &line[pos + 1..];
        if let Some(pos2) = after_type.find(':') {
            return after_type[pos2 + 1..].trim().to_string();
        }
    }
    line.to_string()
}

/// Определить производителя по названию
fn detect_vendor(name: &str) -> String {
    let name_lower = name.to_lowercase();

    if name_lower.contains("nvidia")
        || name_lower.contains("geforce")
        || name_lower.contains("quadro")
        || name_lower.contains("rtx")
        || name_lower.contains("gtx")
    {
        "NVIDIA".to_string()
    } else if name_lower.contains("amd")
        || name_lower.contains("radeon")
        || name_lower.contains("ati")
    {
        "AMD".to_string()
    } else if name_lower.contains("intel")
        || name_lower.contains("iris")
        || name_lower.contains("uhd")
        || name_lower.contains("hd graphics")
    {
        "Intel".to_string()
    } else if name_lower.contains("apple")
        || name_lower.contains("m1")
        || name_lower.contains("m2")
        || name_lower.contains("m3")
    {
        "Apple".to_string()
    } else {
        "Unknown".to_string()
    }
}

/// Классифицировать GPU как дискретный или интегрированный
fn classify_gpu(vendor: &str, name: &str) -> GpuType {
    let name_lower = name.to_lowercase();
    let vendor_lower = vendor.to_lowercase();

    // Intel обычно интегрированная (кроме Arc)
    if vendor_lower.contains("intel") {
        if name_lower.contains("arc") {
            return GpuType::Discrete;
        }
        return GpuType::Integrated;
    }

    // Apple Silicon - интегрированная но мощная
    if vendor_lower.contains("apple")
        || name_lower.contains("m1")
        || name_lower.contains("m2")
        || name_lower.contains("m3")
    {
        return GpuType::Integrated;
    }

    // AMD APU (Vega в названии без RX обычно интегрированная)
    if vendor_lower.contains("amd") {
        if name_lower.contains("vega") && !name_lower.contains("rx") {
            return GpuType::Integrated;
        }
        // Radeon Graphics (без номера модели) - интегрированная
        if name_lower == "radeon graphics" || name_lower.contains("radeon(tm) graphics") {
            return GpuType::Integrated;
        }
    }

    // NVIDIA и AMD с номерами моделей - дискретные
    if vendor_lower.contains("nvidia") || vendor_lower.contains("amd") {
        return GpuType::Discrete;
    }

    GpuType::Unknown
}

/// Получить переменные окружения для принудительного использования GPU
pub fn get_gpu_environment_variables(
    device_id: &str,
    devices: &[GpuDevice],
) -> HashMap<String, String> {
    let mut env_vars = HashMap::new();

    let device = devices.iter().find(|d| d.id == device_id);

    if let Some(gpu) = device {
        let vendor_lower = gpu.vendor.to_lowercase();

        // Linux: DRI_PRIME для гибридной графики
        #[cfg(target_os = "linux")]
        {
            // DRI_PRIME=1 для дискретной GPU на Linux с PRIME
            if gpu.gpu_type == GpuType::Discrete {
                env_vars.insert("DRI_PRIME".to_string(), "1".to_string());
            } else {
                env_vars.insert("DRI_PRIME".to_string(), "0".to_string());
            }

            // Для NVIDIA Optimus
            if vendor_lower.contains("nvidia") {
                env_vars.insert("__NV_PRIME_RENDER_OFFLOAD".to_string(), "1".to_string());
                env_vars.insert(
                    "__GLX_VENDOR_LIBRARY_NAME".to_string(),
                    "nvidia".to_string(),
                );
                env_vars.insert(
                    "__VK_LAYER_NV_optimus".to_string(),
                    "NVIDIA_only".to_string(),
                );
            }
        }

        // Windows: подсказки для драйвера (ограниченно работает)
        #[cfg(target_os = "windows")]
        {
            if vendor_lower.contains("nvidia") && gpu.gpu_type == GpuType::Discrete {
                // Подсказка для NVIDIA Optimus
                env_vars.insert("SHIM_MCCOMPAT".to_string(), "0x800000001".to_string());
            }
        }

        // Общие переменные для Mesa (Linux/некоторые платформы)
        if gpu.gpu_type == GpuType::Discrete {
            // Индекс устройства для Mesa
            if let Ok(idx) = device_id.parse::<usize>() {
                env_vars.insert("MESA_VK_DEVICE_SELECT".to_string(), format!("pci:{}", idx));
            }
        }
    }

    env_vars
}

/// Получить рекомендацию какой GPU использовать
pub fn get_gpu_recommendation(devices: &[GpuDevice]) -> Option<String> {
    if devices.len() <= 1 {
        return None; // Нет выбора
    }

    // Проверяем есть ли и дискретный и интегрированный
    let has_discrete = devices.iter().any(|d| d.gpu_type == GpuType::Discrete);
    let has_integrated = devices.iter().any(|d| d.gpu_type == GpuType::Integrated);

    if has_discrete && has_integrated {
        let discrete = devices.iter().find(|d| d.gpu_type == GpuType::Discrete)?;
        Some(format!(
            "Обнаружена гибридная графика. Рекомендуется использовать {} для лучшей производительности.",
            discrete.name
        ))
    } else {
        None
    }
}

// ========== Tauri Commands ==========

/// Обнаружить доступные GPU
#[tauri::command]
pub fn detect_gpus_command() -> GpuDetectionResult {
    detect_gpus()
}

/// Получить переменные окружения для GPU
#[tauri::command]
pub fn get_gpu_env_vars_command(device_id: String) -> HashMap<String, String> {
    let detection = detect_gpus();
    get_gpu_environment_variables(&device_id, &detection.devices)
}

/// Получить рекомендацию по GPU
#[tauri::command]
pub fn get_gpu_recommendation_command() -> Option<String> {
    let detection = detect_gpus();
    get_gpu_recommendation(&detection.devices)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_classify_gpu_nvidia() {
        assert_eq!(
            classify_gpu("NVIDIA", "GeForce RTX 3080"),
            GpuType::Discrete
        );
        assert_eq!(
            classify_gpu("NVIDIA Corporation", "NVIDIA GeForce GTX 1660"),
            GpuType::Discrete
        );
    }

    #[test]
    fn test_classify_gpu_intel() {
        assert_eq!(
            classify_gpu("Intel", "Intel UHD Graphics 630"),
            GpuType::Integrated
        );
        assert_eq!(
            classify_gpu("Intel Corporation", "Intel Iris Xe Graphics"),
            GpuType::Integrated
        );
        assert_eq!(classify_gpu("Intel", "Intel Arc A770"), GpuType::Discrete);
    }

    #[test]
    fn test_classify_gpu_amd() {
        assert_eq!(
            classify_gpu("AMD", "AMD Radeon RX 6800 XT"),
            GpuType::Discrete
        );
        assert_eq!(
            classify_gpu("AMD", "AMD Radeon Graphics"),
            GpuType::Integrated
        );
        assert_eq!(
            classify_gpu("AMD", "AMD Radeon Vega 8"),
            GpuType::Integrated
        );
    }

    #[test]
    fn test_detect_vendor() {
        assert_eq!(detect_vendor("NVIDIA GeForce RTX 3080"), "NVIDIA");
        assert_eq!(detect_vendor("AMD Radeon RX 6800"), "AMD");
        assert_eq!(detect_vendor("Intel UHD Graphics"), "Intel");
        assert_eq!(detect_vendor("Apple M1 Pro"), "Apple");
    }
}
