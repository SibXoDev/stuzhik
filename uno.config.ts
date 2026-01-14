import {
  defineConfig,
  presetWind4,
  presetAttributify,
  presetIcons,
  presetTypography,
  transformerDirectives,
  transformerVariantGroup
} from 'unocss';

export default defineConfig({
  content: {
    filesystem: [
      'src/**/*.{vue,ts,tsx,js,jsx,html}',
    ],
    pipeline: {
      include: [
        /\.(vue|ts|tsx|js|jsx|html)$/,
      ],
      exclude: [
        'node_modules',
        'src-tauri',
        'dist',
        'target',
        'src/generated',  // Exclude auto-generated source bundle to prevent UnoCSS from parsing stringified code
      ],
    },
  },

  // Custom rules for gray-alpha colors and missing utilities
  rules: [
    ['bg-gray-alpha-30', { 'background-color': 'rgba(26, 27, 31, 0.3)' }],
    ['bg-gray-alpha-50', { 'background-color': 'rgba(26, 27, 31, 0.5)' }],
    ['bg-gray-alpha-70', { 'background-color': 'rgba(26, 27, 31, 0.7)' }],
    // Fix missing container size in presetWind4 v66
    ['max-w-5xl', { 'max-width': '64rem' }],
  ],

  shortcuts: [
    // Buttons - minimum 15px border-radius
    // Используем transition-colors вместо transition-all чтобы не анимировать размеры
    ['btn', 'px-4 py-2.5 font-medium rounded-2xl inline-flex items-center justify-center gap-2 cursor-pointer transition-colors duration-100 disabled:opacity-40 disabled:cursor-not-allowed select-none'],
    ['btn-primary', 'btn bg-blue-600 text-white hover:bg-blue-500 active:bg-blue-700'],
    ['btn-secondary', 'btn bg-gray-750 text-gray-100 hover:bg-[#35363a] active:bg-[#252629]'],
    ['btn-ghost', 'btn bg-transparent text-gray-300 hover:bg-[#2a2b2f] active:bg-[#252629]'],
    ['btn-danger', 'btn bg-red-600/90 text-white hover:bg-red-600 active:bg-red-700'],
    ['btn-success', 'btn bg-green-600/90 text-white hover:bg-green-600 active:bg-green-700'],
    ['btn-sm', 'px-3 py-1.5 text-sm'],
    ['btn-lg', 'px-6 py-3 text-base'],

    // Cards
    ['card', 'bg-gray-850 border border-gray-750 rounded-2xl p-4'],
    ['card-hover', 'card hover:border-[#35363a] transition-colors duration-100 cursor-pointer'],
    ['card-glass', 'bg-gray-alpha-50 backdrop-blur-sm border border-gray-750 rounded-2xl p-4'],

    // Badge
    ['badge', 'inline-flex items-center px-2.5 py-0.5 rounded-md text-xs font-medium'],
    ['badge-primary', 'badge bg-blue-600/20 text-blue-400 border border-blue-600/30'],
    ['badge-success', 'badge bg-green-600/20 text-green-400 border border-green-600/30'],
    ['badge-warning', 'badge bg-yellow-600/20 text-yellow-400 border border-yellow-600/30'],
    ['badge-danger', 'badge bg-red-600/20 text-red-400 border border-red-600/30'],
    ['badge-gray', 'badge bg-gray-700/40 text-gray-300 border border-gray-700'],

    // Text styles
    ['text-muted', 'text-gray-400'],
    ['text-dim', 'text-gray-500'],
    ['text-dimmer', 'text-gray-600'],

    // Layout helpers
    ['flex-center', 'flex items-center justify-center'],
    ['flex-between', 'flex items-center justify-between'],
    ['flex-col-center', 'flex flex-col items-center justify-center'],

    // NEW: Modal & Dialog shortcuts
    ['modal-overlay', 'fixed inset-0 z-50 pt-12 pb-4 px-4 flex items-start justify-center overflow-y-auto'],
    ['modal-content', 'bg-gray-850 border border-gray-750 rounded-2xl p-6 w-full max-h-[calc(100vh-4rem)] overflow-y-auto shadow-2xl my-auto'],

    // Radio/Option buttons - используем transition-colors (не transition-all!)
    ['radio-option', 'relative rounded-2xl border-2 transition-colors duration-75 p-4'],
    ['radio-option-active', 'radio-option border-blue-500 bg-blue-500/10'],
    ['radio-option-inactive', 'radio-option border-gray-700 hover:border-gray-500 hover:bg-gray-alpha-50'],

    // Animation shortcuts - только colors и opacity, НЕ размеры/transform
    ['transition-fast', 'transition-colors duration-100'],
    ['transition-normal', 'transition-colors duration-150'],
  ],

  theme: {
    // Fix missing container sizes in presetWind4 v66
    container: {
      '5xl': '64rem',  // 1024px - missing in presetWind4
    },
    // Override default gray palette with pure grays (no blue tint)
    colors: {
      gray: {
        50: '#fafafb',
        100: '#f0f0f2',
        200: '#e0e1e4',
        300: '#c8c9cd',
        400: '#9a9ba0',
        500: '#6e6f74',
        600: '#505155',
        700: '#35363a',
        750: '#2a2b2f',
        800: '#222326',
        850: '#1a1b1f',
        900: '#141517',
        925: '#0d0d0f',  // DevConsole header/footer
        950: '#0a0a0c',  // Deep black backgrounds
        975: '#08090a',  // WebGL canvas backgrounds
      },
      // Gray alpha variants
      'gray-alpha': {
        30: 'rgba(26, 27, 31, 0.3)',
        50: 'rgba(26, 27, 31, 0.5)',
        70: 'rgba(26, 27, 31, 0.7)',
      },
    },
    extend: {
      fontFamily: {
        sans: ['Rubik', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['Cascadia Code', 'Monaco', 'Consolas', 'monospace'],
      },
      boxShadow: {
        'sm': '0 1px 2px 0 rgb(0 0 0 / 0.3)',
        'DEFAULT': '0 2px 4px 0 rgb(0 0 0 / 0.4)',
        'md': '0 4px 8px 0 rgb(0 0 0 / 0.5)',
        'lg': '0 8px 16px 0 rgb(0 0 0 / 0.6)',
      },
    },
  },

  presets: [
    presetWind4(),
    presetAttributify({
      strict: true,
      // CRITICAL: Only scan specific attribute prefixes to avoid parsing random strings
      prefix: 'un-',
      prefixedOnly: true,  // Only process attributes with un- prefix
    }),
    presetIcons({
      scale: 1,
      warn: true,
      // collections: {
        // hugeicons: () => import('@iconify-json/hugeicons/icons.json').then(i => i.default),
      // },
    }),
    presetTypography(),
    // Fonts are loaded locally from public/fonts/
  ],

  transformers: [
    transformerDirectives(),
    transformerVariantGroup(),
  ],

  // Block false positives from TypeScript/JS code being parsed as CSS
  blocklist: [
    /i-hugeicons-.*-as$/,
    /i-hugeicons-package-\d+$/,
    /i-simple-icons-.*-as$/,
    // Block common variable property suffixes mistaken as icon names
    /i-hugeicons-.*-(const|ext|case|return|type|name|value|length|path|size)$/,

    // CRITICAL: Block JavaScript code patterns that UnoCSS might parse
    // These patterns appear when source code is stringified (e.g., in generated files)
    /scheme-.*\.js/,              // JavaScript scheme patterns (e.g., scheme-RFLM74UC.js)
    /__proto__/,                  // JavaScript prototype chain
    /\$HAS/,                      // JavaScript variable patterns like $HAS
  ],

  safelist: [
    // Dropdown component utilities
    'z-[60]',
    'z-[61]',
    'z-[62]',
    'pointer-events-auto',

    // Container sizes (missing in presetWind4 v66)
    'max-w-5xl',

    // Border colors for Toast, LogAnalyzer, etc. (with opacity variants)
    'border-green-700', 'border-green-600', 'border-green-500',
    'border-green-500/30', 'border-green-500/40', 'border-green-500/50',
    'border-red-700', 'border-red-600', 'border-red-500',
    'border-red-500/20', 'border-red-500/30', 'border-red-500/40', 'border-red-500/50',
    'border-red-600/50',
    'border-amber-700', 'border-amber-600', 'border-amber-500',
    'border-yellow-700', 'border-yellow-600', 'border-yellow-500',
    'border-yellow-500/30', 'border-yellow-500/40', 'border-yellow-500/50',
    'border-blue-700', 'border-blue-600', 'border-blue-500',
    'border-blue-500/30', 'border-blue-500/40', 'border-blue-500/50',
    'border-orange-700', 'border-orange-600', 'border-orange-500',
    'border-orange-500/20', 'border-orange-500/30',
    'border-gray-600', 'border-gray-700',
    // Background colors for Toast and LogAnalyzer
    'bg-green-900/90', 'bg-red-900/90', 'bg-amber-900/90',
    'bg-green-500/5', 'bg-green-500/10', 'bg-green-500/20',
    'bg-red-500/5', 'bg-red-500/10', 'bg-red-500/20',
    'bg-yellow-500/5', 'bg-yellow-500/10', 'bg-yellow-500/20',
    'bg-blue-500/5', 'bg-blue-500/10', 'bg-blue-500/20',
    'bg-orange-500/10',

    // Position utilities that may need explicit inclusion
    'left-1', 'right-1', 'top-1', 'bottom-1',
    'left-2', 'right-2', 'top-2', 'bottom-2',
    'left-3', 'right-3', 'top-3', 'bottom-3',
    'left-4', 'right-4', 'top-4', 'bottom-4',
    'inset-0', 'inset-1', 'inset-2', 'inset-4',
    '-left-1', '-right-1', '-top-1', '-bottom-1',

    // SVG Spinners
    'i-svg-spinners-6-dots-scale',
    'i-svg-spinners-ring-resize',

    // HugeIcons - all used in codebase
    'i-hugeicons-activity-01',
    'i-hugeicons-add-01',
    'i-hugeicons-ai-magic',
    'i-hugeicons-alert-02',
    'i-hugeicons-alert-circle',
    'i-hugeicons-analytics-01',
    'i-hugeicons-archive',
    'i-hugeicons-arrow-down-01',
    'i-hugeicons-arrow-horizontal',
    'i-hugeicons-arrow-left-01',
    'i-hugeicons-arrow-right-01',
    'i-hugeicons-arrow-up-01',
    'i-hugeicons-arrow-up-right-01',
    'i-hugeicons-arrow-vertical',
    'i-hugeicons-book-01',
    'i-hugeicons-book-open-01',
    'i-hugeicons-browser',
    'i-hugeicons-bug-01',
    'i-hugeicons-bulb',
    'i-hugeicons-calendar-01',
    'i-hugeicons-camera-01',
    'i-hugeicons-cancel-01',
    'i-hugeicons-cancel-circle',
    'i-hugeicons-car-01',
    'i-hugeicons-chart-line-data-01',
    'i-hugeicons-chart-relationship',
    'i-hugeicons-checkmark-circle-02',
    'i-hugeicons-clock-01',
    'i-hugeicons-cloud',
    'i-hugeicons-coffee-01',
    'i-hugeicons-colors',
    'i-hugeicons-comment-01',
    'i-hugeicons-computer-terminal-01',
    'i-hugeicons-copy-01',
    'i-hugeicons-code',
    'i-hugeicons-code-square',
    'i-hugeicons-cpu',
    'i-hugeicons-cpu-charge',
    'i-hugeicons-dashboard-speed-01',
    'i-hugeicons-dashboard-square-01',
    'i-hugeicons-database',
    'i-hugeicons-delete-02',
    'i-hugeicons-discord',
    'i-hugeicons-dollar-01',
    'i-hugeicons-download-02',
    'i-hugeicons-earth',
    'i-hugeicons-edit-02',
    'i-hugeicons-file-01',
    'i-hugeicons-file-02',
    'i-hugeicons-file-add',
    'i-hugeicons-file-download',
    'i-hugeicons-file-export',
    'i-hugeicons-file-import',
    'i-hugeicons-file-view',
    'i-hugeicons-filter',
    'i-hugeicons-fire',
    'i-hugeicons-flash',
    'i-hugeicons-floppy-disk',
    'i-hugeicons-folder-01',
    'i-hugeicons-folder-add',
    'i-hugeicons-folder-open',
    'i-hugeicons-folder-search',
    'i-hugeicons-folder-library',
    'i-hugeicons-full-screen',
    'i-hugeicons-game-controller-03',
    'i-hugeicons-git-branch',
    'i-hugeicons-git-compare',
    'i-hugeicons-github',
    'i-hugeicons-globe-02',
    'i-hugeicons-google',
    'i-hugeicons-grid',
    'i-hugeicons-hard-drive',
    'i-hugeicons-help-circle',
    'i-hugeicons-hierarchy',
    'i-hugeicons-hierarchy-square-01',
    'i-hugeicons-idea',
    'i-hugeicons-image-01',
    'i-hugeicons-image-not-found-01',
    'i-hugeicons-information-circle',
    'i-hugeicons-keyboard',
    'i-hugeicons-laptop',
    'i-hugeicons-layout-bottom',
    'i-hugeicons-license',
    'i-hugeicons-link-01',
    'i-hugeicons-loading-01',
    'i-hugeicons-lock',
    'i-hugeicons-magic-wand-01',
    'i-hugeicons-maps-location-01',
    'i-hugeicons-menu-01',
    'i-hugeicons-minimize-01',
    'i-hugeicons-minus-sign',
    'i-hugeicons-more-horizontal',
    'i-hugeicons-more-vertical',
    'i-hugeicons-mouse-left-click-02',
    'i-hugeicons-next',
    'i-hugeicons-notification-01',
    'i-hugeicons-package',
    'i-hugeicons-paint-board',
    'i-hugeicons-paint-brush-01',
    'i-hugeicons-pin',
    'i-hugeicons-pin-off',
    'i-hugeicons-play',
    'i-hugeicons-plug-01',
    'i-hugeicons-power-socket-01',
    'i-hugeicons-qr-code',
    'i-hugeicons-record',
    'i-hugeicons-refresh',
    'i-hugeicons-restaurant-01',
    'i-hugeicons-rocket-01',
    'i-hugeicons-search-01',
    'i-hugeicons-search-02',
    'i-hugeicons-security-check',
    'i-hugeicons-sent',
    'i-hugeicons-settings-02',
    'i-hugeicons-share-01',
    'i-hugeicons-shield-01',
    'i-hugeicons-sidebar-right',
    'i-hugeicons-source-code',
    'i-hugeicons-star',
    'i-hugeicons-stop',
    'i-hugeicons-store-01',
    'i-hugeicons-structure-03',
    'i-hugeicons-test-tube',
    'i-hugeicons-text-font',
    'i-hugeicons-thumbs-down',
    'i-hugeicons-thumbs-up',
    'i-hugeicons-tick-02',
    'i-hugeicons-timer-02',
    'i-hugeicons-tools',
    'i-hugeicons-translate',
    'i-hugeicons-upload-02',
    'i-hugeicons-user',
    'i-hugeicons-user-account',
    'i-hugeicons-user-add-01',
    'i-hugeicons-user-block-01',
    'i-hugeicons-user-check-01',
    'i-hugeicons-user-group',
    'i-hugeicons-user-love-01',
    'i-hugeicons-user-minus-01',
    'i-hugeicons-user-multiple',
    'i-hugeicons-user-settings-01',
    'i-hugeicons-view',
    'i-hugeicons-view-off',
    'i-hugeicons-wifi-01',
    'i-hugeicons-wink',
    'i-hugeicons-wrench-01',
    'i-hugeicons-youtube',
    // Documentation icons
    'i-hugeicons-add-circle',
    'i-hugeicons-arrow-up-02',
    'i-hugeicons-bookmark-01',
    'i-hugeicons-cube',
    'i-hugeicons-database-01',
    'i-hugeicons-home-wifi',
    'i-hugeicons-java-script',
    'i-hugeicons-list-view',
    'i-hugeicons-scissor-01',
    'i-hugeicons-shuffle',
    'i-hugeicons-text',
    // Simple icons (brands)
    'i-simple-icons-modrinth',
    'i-simple-icons-curseforge',
  ],
});