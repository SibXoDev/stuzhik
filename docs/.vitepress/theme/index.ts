import DefaultTheme from 'vitepress/theme'
import TechStack from './components/TechStack.vue'
import './style.css'

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('TechStack', TechStack)
  }
}
