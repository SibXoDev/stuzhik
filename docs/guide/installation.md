---
description: 'Подробная инструкция по установке Stuzhik на Windows, Linux и macOS. Системные требования и способы установки.'
head:
  - - meta
    - name: keywords
      content: stuzhik скачать, установить stuzhik, стужик, minecraft launcher download, системные требования
---

# Установка

## Системные требования

### Минимальные
- **RAM:** 4GB (рекомендуется 8GB)
- **Место на диске:** 2GB + место под экземпляры
- **ОС:** Windows 10+, Ubuntu 20.04+, macOS 10.15+

### Рекомендуемые
- **RAM:** 16GB
- **Место на диске:** SSD с 20GB свободного места
- **GPU:** Любая с поддержкой OpenGL 3.3+

## Из релизов

### Windows

1. Скачай [последний релиз](https://github.com/SibXoDev/minecraft-modpack-constructor/releases/latest)
2. Запусти `.msi` installer
3. Следуй инструкциям установщика

Или portable `.exe`:
```bash
# Просто запусти stuzhik.exe
```

### Linux

#### AppImage (универсальный)
```bash
wget https://github.com/SibXoDev/minecraft-modpack-constructor/releases/latest/download/stuzhik_linux_x64.AppImage
chmod +x stuzhik_linux_x64.AppImage
./stuzhik_linux_x64.AppImage
```

#### Debian/Ubuntu (.deb)
```bash
wget https://github.com/SibXoDev/minecraft-modpack-constructor/releases/latest/download/stuzhik_linux_amd64.deb
sudo dpkg -i stuzhik_linux_amd64.deb
```

### macOS

1. Скачай `.dmg`
2. Открой `.dmg`
3. Перетащи Stuzhik в Applications
4. При первом запуске:
   - System Settings → Privacy & Security
   - Нажми "Open Anyway"

## Из исходников

### Требования

- Rust 1.90.0+
- Bun (или Node.js 20+)
- Git

### Сборка

```bash
git clone https://github.com/SibXoDev/minecraft-modpack-constructor
cd minecraft-modpack-constructor

bun install

bun run tauri build
```

Собранные файлы:
- Windows: `src-tauri/target/release/bundle/msi/`
- Linux: `src-tauri/target/release/bundle/appimage/`
- macOS: `src-tauri/target/release/bundle/dmg/`

## Обновление

Stuzhik проверяет обновления автоматически при запуске.

Вручную:
1. Settings → About
2. Кнопка "Check for updates"

Или скачай новый релиз и установи поверх старого.

## Деинсталляция

### Windows
```
Settings → Apps → Stuzhik → Uninstall
```

### Linux
```bash
sudo dpkg -r stuzhik
```

### macOS
```bash
# Перетащи из Applications в Trash
rm -rf ~/Library/Application\ Support/stuzhik
```

## Troubleshooting

### Не запускается на Windows

Установи [WebView2 Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/):
```bash
winget install Microsoft.EdgeWebView2Runtime
```

### Ошибка прав на Linux

```bash
chmod +x stuzhik_linux_x64.AppImage
```

### macOS: "Cannot be opened"

```
System Settings → Privacy & Security → Open Anyway
```
