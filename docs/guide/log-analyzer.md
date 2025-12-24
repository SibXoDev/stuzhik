---
description: 'Умный анализатор логов Minecraft. Автоматический поиск причин крашей, определение виноватых модов и предложение решений.'
head:
  - - meta
    - name: keywords
      content: minecraft crash analyzer, stuzhik, стужик, анализ логов minecraft, почему вылетает minecraft, minecraft crash fix
---

# Анализатор логов

## Автоматический анализ

При краше игры:

1. Stuzhik автоматически откроет анализатор
2. Покажет найденные проблемы
3. Для каждой - возможные решения
4. Кнопки для автоисправления (где возможно)

## Ручной анализ

Если нужно проанализировать вручную:

1. Открой экземпляр
2. Кнопка "Анализ логов"
3. Выбери тип лога:
   - `crash-report` - последний краш
   - `latest.log` - текущая сессия
   - Выбрать файл вручную

## Типы проблем

### Critical (Критичные)

Полностью блокируют запуск:

| Проблема | Причина | Решение |
|----------|---------|---------|
| Java version mismatch | Неправильная версия Java | Stuzhik установит нужную |
| Missing dependency | Отсутствует нужный мод | Автоустановка |
| Mod conflict | Несовместимые моды | Удалить один из модов |

### High (Высокие)

Вызывают краш во время игры:

- OutOfMemoryError
- Mixin conflicts
- ClassNotFoundException
- NullPointerException в моде

### Medium (Средние)

Могут вызвать проблемы:

- Deprecated warnings
- Config errors
- Missing textures/models

### Low (Низкие)

Не влияют на игру:

- Info сообщения
- Debug логи
- Performance warnings

## Решения

### Автоматические

Кнопка "Применить" для:

**Удаление мода:**
```
Удалить problematic_mod.jar
```

**Увеличение памяти:**
```
Было: 2GB → Стало: 4GB
```

**Установка зависимости:**
```
Установить fabric-api-0.92.0.jar
```

**Изменение конфига:**
```
config/mod.toml: option = false → true
```

### Ручные

Пошаговая инструкция:

1. Скачай мод X версии Y
2. Удали старую версию
3. Положи новую в mods/
4. Перезапусти

## Live мониторинг

### Включение

1. Запусти экземпляр
2. Stuzhik автоматически начнёт мониторинг
3. Индикатор в header покажет статус

### События

**Warning:** Предупреждения из лога
```
[Sodium] Incompatible mixin detected
```

**Error:** Ошибки без краша
```
[KubeJS] Script error in startup.js:15
```

**Crash:** Полный краш
```
Game crashed! Analyzing...
```

### Уведомления

При обнаружении проблемы:
1. Всплывающее уведомление
2. Список проблем в live panel
3. Кнопки для исправления

## История крашей

### Статистика

Вкладка "История" показывает:

- Всего крашей
- За последнюю неделю
- За последний день
- % успешных исправлений

### Тренды по модам

График показывает:

| Мод | Крашей | Тренд |
|-----|--------|-------|
| problematic_mod | 15 | ⬆️ Worsening |
| stable_mod | 2 | ➡️ Stable |
| fixed_mod | 0 | ⬇️ Improving |

**Worsening:** Стоит удалить или обновить
**Stable:** Редкие краши, норма
**Improving:** Обновления помогают

### Фильтры

- По дате
- По моду
- По категории проблемы
- Только неисправленные

## База знаний

### Обучение

Когда применяешь решение:

1. Stuzhik сохраняет результат
2. "Помогло" / "Не помогло"
3. Success rate обновляется

### Персонализация

Решения ранжируются:

| Решение | Success Rate | Показывать |
|---------|--------------|------------|
| Удалить мод | 95% | ✅ Первым |
| Обновить | 70% | ✅ Вторым |
| Изменить конфиг | 30% | ⚠️ С предупреждением |

### Топ решений

Вкладка "Популярные решения":

1. Решения с лучшим success rate
2. Применённые другими пользователями
3. Рекомендации для похожих проблем

## Экспорт

### Для отчёта

1. Анализатор → "Экспорт"
2. Выбери формат:
   - `.txt` - читаемый текст
   - `.json` - для парсинга
   - `.zip` - лог + анализ

### Для поддержки

При обращении к автору мода:

1. Экспорт → "Архив для поддержки"
2. Включает:
   - Лог краша
   - Список модов
   - Версии MC/загрузчика
   - Анализ Stuzhik
3. Прикрепи к issue на GitHub

## Паттерны ошибок

Stuzhik распознаёт ~50 типов ошибок:

### Java

- OutOfMemoryError
- StackOverflowError
- UnsupportedClassVersionError
- NoClassDefFoundError

### Minecraft

- Missing registry entries
- Invalid block states
- Corrupted chunk data
- Missing textures

### Моды

- Mixin conflicts
- ASM transformation failures
- Config parsing errors
- Dependency issues

### Загрузчики

- Forge mod on Fabric
- Missing Fabric API
- Incompatible loader version

## Advanced

### Regex поиск

Dev Console (`Ctrl+Shift+D`):

```
Filter: /ERROR.*sodium/i
```

Покажет только ошибки с "sodium"

### Экспорт паттернов

Создай кастомный паттерн:

```json
{
  "pattern": "\\[MyMod\\] Error: (.+)",
  "category": "ModError",
  "severity": "high",
  "solution": "Удали MyMod или обнови до последней версии"
}
```

Импорт: Settings → Log Analyzer → Import Patterns
