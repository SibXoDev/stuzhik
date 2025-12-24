use crate::error::Result;
use rand::{rngs::OsRng, TryRngCore};
use sha1::{Digest, Sha1};
use sha2::Sha256;
use std::fs::File;
use std::io::{Read, Write};
use std::path::Path;

/// Генерация короткого ID (base62) заданной длины
pub fn gen_short_id(len: usize) -> String {
    const ALPHABET: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    let mut out = vec![0u8; len];
    let mut buf = vec![0u8; len];

    let mut rng = OsRng;
    let _ = rng.try_fill_bytes(&mut buf);

    for i in 0..len {
        let idx = (buf[i] as usize) % ALPHABET.len();
        out[i] = ALPHABET[idx];
    }

    unsafe { String::from_utf8_unchecked(out) }
}

/// Вычисление SHA1 хеша файла
pub fn calculate_sha1<P: AsRef<Path>>(path: P) -> Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha1::new();
    let mut buffer = [0; 8192];

    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }

    Ok(format!("{:x}", hasher.finalize()))
}

/// Вычисление SHA256 хеша файла
pub fn calculate_sha256<P: AsRef<Path>>(path: P) -> Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0; 8192];

    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }

    Ok(format!("{:x}", hasher.finalize()))
}

/// Верификация файла по хешу
pub fn verify_file_hash<P: AsRef<Path>>(path: P, expected: &str) -> Result<bool> {
    let actual = if expected.len() == 40 {
        calculate_sha1(&path)?
    } else {
        calculate_sha256(&path)?
    };

    Ok(actual.eq_ignore_ascii_case(expected))
}

/// Форматирование размера файла в человекочитаемый вид
pub fn format_bytes(bytes: u64) -> String {
    const UNITS: &[&str] = &["B", "KB", "MB", "GB", "TB"];
    let mut size = bytes as f64;
    let mut unit_idx = 0;

    while size >= 1024.0 && unit_idx < UNITS.len() - 1 {
        size /= 1024.0;
        unit_idx += 1;
    }

    if unit_idx == 0 {
        format!("{} {}", bytes, UNITS[0])
    } else {
        format!("{:.2} {}", size, UNITS[unit_idx])
    }
}

/// Парсинг версии в semver
pub fn parse_version(version: &str) -> Option<semver::Version> {
    // Пытаемся распарсить напрямую
    if let Ok(v) = semver::Version::parse(version) {
        return Some(v);
    }

    // Пытаемся очистить версию от префиксов (v1.0.0 -> 1.0.0)
    let cleaned = version.trim_start_matches('v');
    if let Ok(v) = semver::Version::parse(cleaned) {
        return Some(v);
    }

    // Пытаемся добавить .0 если версия неполная (1.20 -> 1.20.0)
    let parts: Vec<&str> = cleaned.split('.').collect();
    if parts.len() == 2 {
        let full = format!("{}.0", cleaned);
        if let Ok(v) = semver::Version::parse(&full) {
            return Some(v);
        }
    }

    None
}

/// Сравнение версий
pub fn compare_versions(a: &str, b: &str) -> std::cmp::Ordering {
    match (parse_version(a), parse_version(b)) {
        (Some(va), Some(vb)) => va.cmp(&vb),
        _ => a.cmp(b), // Fallback на строковое сравнение
    }
}

/// Проверка соответствия версии требованию
pub fn version_matches_requirement(version: &str, requirement: &str) -> bool {
    let version = match parse_version(version) {
        Some(v) => v,
        None => return false,
    };

    // Парсим requirement (>=1.0.0, [1.0.0,2.0.0), etc.)
    if requirement.starts_with(">=") {
        if let Some(req_ver) = parse_version(&requirement[2..]) {
            return version >= req_ver;
        }
    } else if requirement.starts_with("<=") {
        if let Some(req_ver) = parse_version(&requirement[2..]) {
            return version <= req_ver;
        }
    } else if requirement.starts_with('>') {
        if let Some(req_ver) = parse_version(&requirement[1..]) {
            return version > req_ver;
        }
    } else if requirement.starts_with('<') {
        if let Some(req_ver) = parse_version(&requirement[1..]) {
            return version < req_ver;
        }
    } else if requirement.starts_with('[') && requirement.ends_with(')') {
        // Range [min,max)
        let inner = &requirement[1..requirement.len() - 1];
        if let Some((min_str, max_str)) = inner.split_once(',') {
            if let (Some(min), Some(max)) =
                (parse_version(min_str.trim()), parse_version(max_str.trim()))
            {
                return version >= min && version < max;
            }
        }
    } else if requirement.starts_with('[') && requirement.ends_with(']') {
        // Range [min,max]
        let inner = &requirement[1..requirement.len() - 1];
        if let Some((min_str, max_str)) = inner.split_once(',') {
            if let (Some(min), Some(max)) =
                (parse_version(min_str.trim()), parse_version(max_str.trim()))
            {
                return version >= min && version <= max;
            }
        }
    } else {
        // Точное совпадение
        if let Some(req_ver) = parse_version(requirement) {
            return version == req_ver;
        }
    }

    false
}

/// Sanitize имени файла (удаление опасных символов)
pub fn sanitize_filename(name: &str) -> String {
    name.chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => c,
        })
        .collect()
}

/// Создание backup файла
pub fn backup_file<P: AsRef<Path>>(path: P) -> Result<()> {
    let path = path.as_ref();
    if !path.exists() {
        return Ok(());
    }

    let backup_path = path.with_extension(format!(
        "{}.backup.{}",
        path.extension().and_then(|s| s.to_str()).unwrap_or(""),
        chrono::Utc::now().timestamp()
    ));

    std::fs::copy(path, backup_path)?;
    Ok(())
}

/// Безопасное атомарное сохранение файла
pub fn atomic_write<P: AsRef<Path>>(path: P, content: &[u8]) -> Result<()> {
    let path = path.as_ref();
    let tmp_path = path.with_extension("tmp");

    let mut file = File::create(&tmp_path)?;
    file.write_all(content)?;
    file.sync_all()?;
    drop(file);

    std::fs::rename(tmp_path, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_gen_short_id() {
        let id = gen_short_id(8);
        assert_eq!(id.len(), 8);
    }

    #[test]
    fn test_format_bytes() {
        assert_eq!(format_bytes(512), "512 B");
        assert_eq!(format_bytes(1024), "1.00 KB");
        assert_eq!(format_bytes(1_048_576), "1.00 MB");
    }

    #[test]
    fn test_parse_version() {
        assert!(parse_version("1.0.0").is_some());
        assert!(parse_version("v1.0.0").is_some());
        assert!(parse_version("1.20").is_some());
    }

    #[test]
    fn test_version_matches() {
        assert!(version_matches_requirement("1.5.0", ">=1.0.0"));
        assert!(version_matches_requirement("1.5.0", "[1.0.0,2.0.0)"));
        assert!(!version_matches_requirement("2.0.0", "[1.0.0,2.0.0)"));
    }
}
