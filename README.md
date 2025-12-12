# Stuzhik

Лаунчер для Minecraft с управлением модами и анализом крашей.

<p align="center">
  <img src="public/logo.png" width="200" alt="Project Logo">
</p>

**Документация:** [stuzhik.ru](https://stuzhik.ru)

## Возможности

- Управление экземплярами Minecraft (Forge, Fabric, NeoForge, Quilt)
- Установка модов из Modrinth и CurseForge
- Импорт/экспорт модпаков
- Анализатор логов - находит причину краша и предлагает решения
- Автообновление модов

## Установка

Скачай релиз для своей системы: [Releases](https://github.com/SibXoDev/stuzhik/releases)

- Windows: `.msi` или `.exe`
- Linux: ![WIP](https://img.shields.io/badge/status-WIP-orange)
- macOS: ![Planned](https://img.shields.io/badge/status-planned-lightgrey)

## Сборка из исходников

```bash
git clone https://github.com/SibXoDev/stuzhik
cd stuzhik
bun install
bun run tauri build
```

Требования: Rust 1.90+, Bun (или npm/pnpm)

## Стек

- **Backend:** Rust, Tauri 2, SQLite
- **Frontend:** TypeScript, SolidJS, UnoCSS
