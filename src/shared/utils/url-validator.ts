/**
 * URL validation utilities for security.
 * Prevents XSS attacks through javascript:, data:, and other dangerous protocols.
 */

/**
 * List of allowed protocols for image URLs.
 */
const ALLOWED_IMAGE_PROTOCOLS = ["https:", "http:"];

/**
 * List of allowed protocols for external links.
 */
const ALLOWED_LINK_PROTOCOLS = ["https:", "http:", "mailto:"];

/**
 * Trusted CDN domains for mod icons and images.
 */
const TRUSTED_IMAGE_DOMAINS = [
  "cdn.modrinth.com",
  "media.forgecdn.net",
  "cdn-raw.modrinth.com",
  "github.com",
  "raw.githubusercontent.com",
  "i.imgur.com",
];

/**
 * Validates that an image URL is safe to load.
 * Blocks javascript:, data:, blob:, and other dangerous protocols.
 *
 * @param url - The URL to validate
 * @param strictMode - If true, only allows trusted CDN domains
 * @returns true if the URL is safe to use in an img src attribute
 */
export function isValidImageUrl(url: string | undefined | null, strictMode = false): boolean {
  if (!url || typeof url !== "string") return false;

  // Trim whitespace
  const trimmedUrl = url.trim();
  if (!trimmedUrl) return false;

  try {
    const parsed = new URL(trimmedUrl, window.location.origin);

    // Check protocol
    if (!ALLOWED_IMAGE_PROTOCOLS.includes(parsed.protocol)) {
      return false;
    }

    // In strict mode, only allow trusted domains
    if (strictMode && !TRUSTED_IMAGE_DOMAINS.some((domain) => parsed.hostname.endsWith(domain))) {
      return false;
    }

    return true;
  } catch {
    // Allow relative URLs (they're safe)
    return trimmedUrl.startsWith("/") || trimmedUrl.startsWith("./");
  }
}

/**
 * Validates that a link URL is safe to navigate to.
 * Blocks javascript:, data:, and other dangerous protocols.
 *
 * @param url - The URL to validate
 * @returns true if the URL is safe to use in an anchor href attribute
 */
export function isValidLinkUrl(url: string | undefined | null): boolean {
  if (!url || typeof url !== "string") return false;

  const trimmedUrl = url.trim();
  if (!trimmedUrl) return false;

  try {
    const parsed = new URL(trimmedUrl, window.location.origin);
    return ALLOWED_LINK_PROTOCOLS.includes(parsed.protocol);
  } catch {
    // Allow relative URLs and fragment identifiers
    return trimmedUrl.startsWith("/") || trimmedUrl.startsWith("./") || trimmedUrl.startsWith("#");
  }
}

/**
 * Sanitizes an image URL, returning a fallback if invalid.
 *
 * @param url - The URL to sanitize
 * @param fallback - The fallback URL to return if invalid (default: empty string)
 * @returns The original URL if valid, or the fallback
 */
export function sanitizeImageUrl(url: string | undefined | null, fallback = ""): string {
  return isValidImageUrl(url) ? url!.trim() : fallback;
}

/**
 * Sanitizes a link URL, returning a fallback if invalid.
 *
 * @param url - The URL to sanitize
 * @param fallback - The fallback URL to return if invalid (default: "#")
 * @returns The original URL if valid, or the fallback
 */
export function sanitizeLinkUrl(url: string | undefined | null, fallback = "#"): string {
  return isValidLinkUrl(url) ? url!.trim() : fallback;
}

/**
 * Creates safe props for an external link.
 * Adds target="_blank" and rel="noopener noreferrer" for security.
 *
 * @param url - The URL for the link
 * @returns Props object for an anchor element, or empty object if URL is invalid
 */
export function getExternalLinkProps(url: string | undefined | null): {
  href?: string;
  target?: string;
  rel?: string;
} {
  if (!isValidLinkUrl(url)) {
    return {};
  }

  return {
    href: url!.trim(),
    target: "_blank",
    rel: "noopener noreferrer",
  };
}
