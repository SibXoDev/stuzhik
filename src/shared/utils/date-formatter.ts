/**
 * Форматирование времени в относительном формате ("час назад", "вчера")
 */
export function formatRelativeTime(dateString: string, locale: 'ru' | 'en' = 'ru'): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);
  const diffWeek = Math.floor(diffDay / 7);
  const diffMonth = Math.floor(diffDay / 30);
  const diffYear = Math.floor(diffDay / 365);

  if (locale === 'ru') {
    if (diffSec < 60) return 'только что';
    if (diffMin === 1) return 'минуту назад';
    if (diffMin < 5) return `${diffMin} минуты назад`;
    if (diffMin < 60) return `${diffMin} минут назад`;
    if (diffHour === 1) return 'час назад';
    if (diffHour < 5) return `${diffHour} часа назад`;
    if (diffHour < 24) return `${diffHour} часов назад`;
    if (diffDay === 1) return 'вчера';
    if (diffDay < 7) return `${diffDay} дня назад`;
    if (diffWeek === 1) return 'неделю назад';
    if (diffWeek < 4) return `${diffWeek} недели назад`;
    if (diffMonth === 1) return 'месяц назад';
    if (diffMonth < 12) return `${diffMonth} месяца назад`;
    if (diffYear === 1) return 'год назад';
    return `${diffYear} лет назад`;
  } else {
    // English
    if (diffSec < 60) return 'just now';
    if (diffMin === 1) return '1 minute ago';
    if (diffMin < 60) return `${diffMin} minutes ago`;
    if (diffHour === 1) return '1 hour ago';
    if (diffHour < 24) return `${diffHour} hours ago`;
    if (diffDay === 1) return 'yesterday';
    if (diffDay < 7) return `${diffDay} days ago`;
    if (diffWeek === 1) return '1 week ago';
    if (diffWeek < 4) return `${diffWeek} weeks ago`;
    if (diffMonth === 1) return '1 month ago';
    if (diffMonth < 12) return `${diffMonth} months ago`;
    if (diffYear === 1) return '1 year ago';
    return `${diffYear} years ago`;
  }
}

/**
 * Форматирование полной даты и времени
 */
export function formatFullDateTime(dateString: string, locale: 'ru' | 'en' = 'ru'): string {
  const date = new Date(dateString);

  if (locale === 'ru') {
    const day = date.getDate().toString().padStart(2, '0');
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const year = date.getFullYear();
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    const seconds = date.getSeconds().toString().padStart(2, '0');

    return `${day}.${month}.${year} в ${hours}:${minutes}:${seconds}`;
  } else {
    return date.toLocaleString('en-US', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  }
}
