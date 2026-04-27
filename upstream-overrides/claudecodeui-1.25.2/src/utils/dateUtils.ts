import type { TFunction } from 'i18next';

const NUMERIC_TIMESTAMP_PATTERN = /^\d+$/;

export const parseDateInput = (value: Date | string | number | null | undefined): Date => {
  if (value instanceof Date) {
    return new Date(value.getTime());
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value < 1e12 ? value * 1000 : value);
  }

  if (typeof value === 'string') {
    const trimmedValue = value.trim();

    if (!trimmedValue) {
      return new Date(Number.NaN);
    }

    if (NUMERIC_TIMESTAMP_PATTERN.test(trimmedValue)) {
      const numericTimestamp = Number(trimmedValue);

      if (Number.isFinite(numericTimestamp)) {
        return new Date(numericTimestamp < 1e12 ? numericTimestamp * 1000 : numericTimestamp);
      }
    }

    return new Date(trimmedValue);
  }

  return new Date(Number.NaN);
};

export const formatTimeAgo = (dateInput: string, currentTime: Date, t: TFunction) => {
  const date = parseDateInput(dateInput);
  const now = currentTime;

  if (isNaN(date.getTime())) {
    return t ? t('status.unknown') : 'Unknown';
  }

  const diffInMs = now.getTime() - date.getTime();
  const diffInSeconds = Math.floor(diffInMs / 1000);
  const diffInMinutes = Math.floor(diffInMs / (1000 * 60));
  const diffInHours = Math.floor(diffInMs / (1000 * 60 * 60));
  const diffInDays = Math.floor(diffInMs / (1000 * 60 * 60 * 24));

  if (diffInSeconds < 60) return t ? t('time.justNow') : 'Just now';
  if (diffInMinutes === 1) return t ? t('time.oneMinuteAgo') : '1 min ago';
  if (diffInMinutes < 60) return t ? t('time.minutesAgo', { count: diffInMinutes }) : `${diffInMinutes} mins ago`;
  if (diffInHours === 1) return t ? t('time.oneHourAgo') : '1 hour ago';
  if (diffInHours < 24) return t ? t('time.hoursAgo', { count: diffInHours }) : `${diffInHours} hours ago`;
  if (diffInDays === 1) return t ? t('time.oneDayAgo') : '1 day ago';
  if (diffInDays < 7) return t ? t('time.daysAgo', { count: diffInDays }) : `${diffInDays} days ago`;
  return date.toLocaleDateString();
};
