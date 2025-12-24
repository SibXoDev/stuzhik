<script setup>
import RustIcon from '~icons/devicon/rust'
import TauriIcon from '~icons/devicon/tauri'
import SolidjsIcon from '~icons/devicon/solidjs'
import TypescriptIcon from '~icons/devicon/typescript'
import SqliteIcon from '~icons/devicon/sqlite'
</script>

<template>
  <div class="tech-grid">
    <div class="tech-card">
      <RustIcon width="36" height="36" />
      <span class="tech-name">Rust</span>
    </div>
    <div class="tech-card">
      <TauriIcon width="36" height="36" />
      <span class="tech-name">Tauri</span>
    </div>
    <div class="tech-card">
      <SolidjsIcon width="36" height="36" />
      <span class="tech-name">SolidJS</span>
    </div>
    <div class="tech-card">
      <TypescriptIcon width="36" height="36" />
      <span class="tech-name">TypeScript</span>
    </div>
    <div class="tech-card">
      <SqliteIcon width="36" height="36" />
      <span class="tech-name">SQLite</span>
    </div>
  </div>
</template>
