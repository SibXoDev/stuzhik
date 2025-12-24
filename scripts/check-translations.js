#!/usr/bin/env bun

/**
 * Translation Completeness Checker
 *
 * Validates that all translation files have the same structure and keys as the base language (ru.json).
 * Used in CI to ensure translation quality.
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Colors for terminal output
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

/**
 * Get all keys from a nested object with dot notation
 * Example: { common: { create: "..." } } -> ["common.create"]
 */
function getAllKeys(obj, prefix = '') {
  let keys = [];
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      keys.push(...getAllKeys(value, fullKey));
    } else {
      keys.push(fullKey);
    }
  }
  return keys;
}

/**
 * Check if a translation file is complete compared to base
 */
function checkTranslation(baseLang, targetLang, baseKeys, targetKeys) {
  const missing = baseKeys.filter(k => !targetKeys.includes(k));
  const extra = targetKeys.filter(k => !baseKeys.includes(k));

  const coverage = baseKeys.length > 0
    ? ((targetKeys.length - extra.length) / baseKeys.length * 100).toFixed(1)
    : 100;

  return { missing, extra, coverage };
}

/**
 * Main function
 */
function main() {
  const localesDir = join(__dirname, '..', 'locales');

  // Check if locales directory exists
  if (!existsSync(localesDir)) {
    console.error(`${colors.red}✗${colors.reset} Locales directory not found: ${localesDir}`);
    process.exit(1);
  }

  // Read base language (Russian)
  const baseFile = join(localesDir, 'ru.json');
  if (!existsSync(baseFile)) {
    console.error(`${colors.red}✗${colors.reset} Base translation file not found: ru.json`);
    process.exit(1);
  }

  let baseTranslations;
  try {
    baseTranslations = JSON.parse(readFileSync(baseFile, 'utf8'));
  } catch (e) {
    console.error(`${colors.red}✗${colors.reset} Failed to parse ru.json: ${e.message}`);
    process.exit(1);
  }

  const baseKeys = getAllKeys(baseTranslations);
  console.log(`${colors.blue}ℹ${colors.reset} Base language (ru): ${baseKeys.length} keys\n`);

  // Check all other translation files
  const files = readdirSync(localesDir).filter(f => f.endsWith('.json') && f !== 'ru.json');

  if (files.length === 0) {
    console.log(`${colors.yellow}⚠${colors.reset} No other translation files found`);
    process.exit(0);
  }

  let hasErrors = false;

  for (const file of files) {
    const lang = basename(file, '.json');
    const filePath = join(localesDir, file);

    let translations;
    try {
      translations = JSON.parse(readFileSync(filePath, 'utf8'));
    } catch (e) {
      console.error(`${colors.red}✗${colors.reset} Failed to parse ${file}: ${e.message}`);
      hasErrors = true;
      continue;
    }

    const targetKeys = getAllKeys(translations);
    const { missing, extra, coverage } = checkTranslation('ru', lang, baseKeys, targetKeys);

    // Print results
    console.log(`${colors.cyan}${lang}.json${colors.reset}`);
    console.log(`  Coverage: ${coverage}% (${targetKeys.length - extra.length}/${baseKeys.length})`);

    if (missing.length > 0) {
      console.log(`  ${colors.red}✗${colors.reset} Missing keys (${missing.length}):`);
      missing.slice(0, 10).forEach(key => {
        console.log(`    - ${key}`);
      });
      if (missing.length > 10) {
        console.log(`    ... and ${missing.length - 10} more`);
      }
      hasErrors = true;
    }

    if (extra.length > 0) {
      console.log(`  ${colors.yellow}⚠${colors.reset} Extra keys (${extra.length}):`);
      extra.slice(0, 5).forEach(key => {
        console.log(`    - ${key}`);
      });
      if (extra.length > 5) {
        console.log(`    ... and ${extra.length - 5} more`);
      }
    }

    if (missing.length === 0 && extra.length === 0) {
      console.log(`  ${colors.green}✓${colors.reset} Complete!`);
    }

    console.log('');
  }

  // Summary
  if (hasErrors) {
    console.error(`${colors.red}✗${colors.reset} Translation check failed`);
    console.error(`\n${colors.yellow}Please update translation files to match the base language (ru.json)${colors.reset}`);
    process.exit(1);
  } else {
    console.log(`${colors.green}✓${colors.reset} All translations are complete!`);
    process.exit(0);
  }
}

main();
