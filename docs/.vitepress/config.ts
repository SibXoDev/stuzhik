import { defineConfig } from 'vitepress'
import Icons from 'unplugin-icons/vite'

const REPO = 'https://github.com/SibXoDev/stuzhik'
const SITE_URL = 'https://stuzhik.ru'

export default defineConfig({
  title: 'Stuzhik',
  description: 'Minecraft лаунчер с анализом крашей, управлением модами и live мониторингом. Быстрый, умный, на Rust.',
  lang: 'ru-RU',
  base: "/",

  head: [
    // Favicon
    ['link', { rel: 'icon', type: 'image/x-icon', href: '/favicon.ico' }],
    ['link', { rel: 'icon', type: 'image/png', sizes: '32x32', href: '/favicon-32x32.png' }],
    ['link', { rel: 'apple-touch-icon', sizes: '180x180', href: '/logo.png' }],

    // SEO
    ['meta', { name: 'yandex-verification', content: '02c97d76d7c52df4' }],
    ['meta', { name: 'theme-color', content: '#2563eb' }],
    ['meta', { name: 'keywords', content: 'minecraft лаунчер, minecraft launcher, stuzhik, модпаки, modrinth, curseforge, forge, fabric, neoforge, quilt, анализ крашей, crash analyzer, minecraft mods, управление модами' }],
    ['meta', { name: 'author', content: 'SibXoDev' }],
    ['meta', { name: 'robots', content: 'index, follow' }],
    ['link', { rel: 'canonical', href: SITE_URL }],

    // Open Graph
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:locale', content: 'ru_RU' }],
    ['meta', { property: 'og:site_name', content: 'Stuzhik' }],
    ['meta', { property: 'og:title', content: 'Stuzhik - Minecraft лаунчер с анализом крашей' }],
    ['meta', { property: 'og:description', content: 'Быстрый лаунчер на Rust с умным анализом логов, управлением модами и live мониторингом' }],
    ['meta', { property: 'og:image', content: `${SITE_URL}/logo.png` }],
    ['meta', { property: 'og:url', content: SITE_URL }],

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
      copyright: '© 2025 Stuzhik'
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
