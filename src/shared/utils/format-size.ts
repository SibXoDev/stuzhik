/**
 * Format bytes to human-readable size with localized units
 */
export interface SizeUnits {
  bytes: string;
  kilobytes: string;
  megabytes: string;
  gigabytes: string;
  terabytes: string;
}

const DEFAULT_UNITS: SizeUnits = {
  bytes: "B",
  kilobytes: "KB",
  megabytes: "MB",
  gigabytes: "GB",
  terabytes: "TB",
};

/**
 * Format bytes to human-readable size string
 * @param bytes - Number of bytes
 * @param units - Localized unit labels (optional, defaults to English)
 * @returns Formatted size string (e.g., "1.5 MB")
 */
export function formatSize(bytes: number, units?: Partial<SizeUnits>): string {
  const u = { ...DEFAULT_UNITS, ...units };

  if (bytes === 0) return `0 ${u.bytes}`;

  const k = 1024;
  const sizes = [u.bytes, u.kilobytes, u.megabytes, u.gigabytes, u.terabytes];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);

  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}
