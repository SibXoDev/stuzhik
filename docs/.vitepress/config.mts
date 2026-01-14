import { defineConfig } from 'vitepress'
import Icons from 'unplugin-icons/vite'

const REPO = 'https://github.com/SibXoDev/stuzhik'
const SITE_URL = 'https://stuzhik.ru'
const SITE_TITLE = 'Stuzhik - Minecraft лаунчер'
const SITE_DESCRIPTION = 'Быстрый Minecraft лаунчер на Rust с умным анализом крашей, управлением модами, поддержкой Modrinth и CurseForge. Совместим с Forge, Fabric, NeoForge и Quilt.'

export default defineConfig({
  title: 'Stuzhik',
  description: SITE_DESCRIPTION,
  lang: 'ru-RU',
  base: "/",

  head: [
    // Favicon
    ['link', { rel: 'icon', type: 'image/x-icon', href: '/favicon.ico' }],
    ['link', { rel: 'icon', type: 'image/png', sizes: '32x32', href: '/favicon-32x32.png' }],
    ['link', { rel: 'apple-touch-icon', sizes: '180x180', href: '/logo.png' }],

    // SEO основные
    ['meta', { name: 'theme-color', content: '#2563eb' }],
    ['meta', { name: 'robots', content: 'index, follow' }],
    ['meta', { name: 'author', content: 'SibXoDev' }],
    // NOTE: Static canonical REMOVED - it was pointing ALL pages to homepage!
    // VitePress generates proper canonical URLs automatically via sitemap.
    // Google was showing "Вариант страницы с тегом canonical" error because of this.

    // Ключевые слова на русском и английском для лучшего SEO
    ['meta', {
      name: 'keywords',
      content: 'minecraft лаунчер, minecraft launcher, stuzhik, стужик, модпаки, modrinth, curseforge, forge, fabric, neoforge, quilt, анализ крашей, crash analyzer, minecraft mods, управление модами, mod manager, лаунчер майнкрафт, бесплатный лаунчер, free minecraft launcher, minecraft mod launcher, tlauncher alternative, multimc alternative, prism launcher alternative'
    }],

    // Альтернативные имена/поисковые запросы
    ['meta', { name: 'application-name', content: 'Stuzhik Minecraft Launcher' }],

    // Open Graph (Facebook, VK, Telegram)
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:locale', content: 'ru_RU' }],
    ['meta', { property: 'og:locale:alternate', content: 'en_US' }],
    ['meta', { property: 'og:site_name', content: 'Stuzhik' }],
    ['meta', { property: 'og:title', content: SITE_TITLE }],
    ['meta', { property: 'og:description', content: SITE_DESCRIPTION }],
    ['meta', { property: 'og:image', content: `${SITE_URL}/og-image.png` }],
    ['meta', { property: 'og:image:width', content: '1200' }],
    ['meta', { property: 'og:image:height', content: '630' }],
    ['meta', { property: 'og:url', content: SITE_URL }],

    // Структурированные данные JSON-LD
    ['script', { type: 'application/ld+json' }, JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      'name': 'Stuzhik',
      'applicationCategory': 'GameApplication',
      'operatingSystem': 'Windows, macOS, Linux',
      'description': SITE_DESCRIPTION,
      'url': SITE_URL,
      'downloadUrl': `${REPO}/releases/latest`,
      'author': {
        '@type': 'Person',
        'name': 'SibXoDev',
        'url': 'https://github.com/SibXoDev'
      },
      'offers': {
        '@type': 'Offer',
        'price': '0',
        'priceCurrency': 'USD'
      },
      'aggregateRating': {
        '@type': 'AggregateRating',
        'ratingValue': '5',
        'ratingCount': '1'
      },
      'screenshot': `${SITE_URL}/screenshot.png`,
      'softwareVersion': '0.0.3',
      'releaseNotes': 'Добавлена документация, улучшен UI, добавлен Stuzhik Connect',
      'datePublished': '2024-12-01',
      'keywords': 'minecraft launcher, mod manager, crash analyzer, forge, fabric, modrinth, curseforge'
    })],

    // Структурированные данные для организации
    ['script', { type: 'application/ld+json' }, JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      'name': 'Stuzhik',
      'url': SITE_URL,
      'potentialAction': {
        '@type': 'SearchAction',
        'target': `${SITE_URL}/search?q={search_term_string}`,
        'query-input': 'required name=search_term_string'
      }
    })],
  ],

  themeConfig: {
    logo: '/logo.png',
    siteTitle: 'Stuzhik',

    nav: [
      { text: 'Главная', link: '/' },
      { text: 'Документация', link: '/guide/quick-start' },
      { text: 'FAQ', link: '/faq' },
    ],

    sidebar: [
      {
        text: 'Начало',
        items: [
          { text: 'Быстрый старт', link: '/guide/quick-start' },
          { text: 'Установка', link: '/guide/installation' },
        ]
      },
      {
        text: 'Возможности',
        items: [
          { text: 'Анализатор логов', link: '/guide/log-analyzer' },
          { text: 'Моды', link: '/guide/mods' },
          { text: 'Модпаки', link: '/guide/modpacks' },
        ]
      },
      {
        text: 'Справка',
        items: [
          { text: 'FAQ', link: '/faq' },
        ]
      }
    ],

    socialLinks: [
      { icon: 'github', link: REPO }
    ],

    footer: {
      copyright: '© 2024-2025 Stuzhik • Made with ❄️ in Siberia'
    },

    search: {
      provider: 'local',
      options: {
        translations: {
          button: { buttonText: 'Поиск', buttonAriaLabel: 'Поиск' },
          modal: {
            noResultsText: 'Нет результатов',
            resetButtonTitle: 'Сбросить',
            footer: { selectText: 'выбрать', navigateText: 'навигация', closeText: 'закрыть' }
          }
        }
      }
    },

    docFooter: { prev: 'Назад', next: 'Далее' },
    outline: { label: 'На странице', level: [2, 3] },
    sidebarMenuLabel: 'Меню',
    returnToTopLabel: 'Наверх',
  },

  appearance: false,
  markdown: { theme: 'github-dark' },
  sitemap: { hostname: SITE_URL },

  vite: {
    plugins: [
      Icons({ compiler: 'vue3' }) as any
    ]
  }
})
