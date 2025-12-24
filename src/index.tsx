/* @refresh reload */
// IMPORTANT: Import console interceptor FIRST to catch all logs
import "./shared/utils/console-interceptor";

import { render } from "solid-js/web";
import App from "./App";
import 'virtual:uno.css';
// Fonts bundled locally via fontsource (no network requests)
import '@fontsource/rubik/300.css';
import '@fontsource/rubik/400.css';
import '@fontsource/rubik/500.css';
import '@fontsource/rubik/600.css';
import '@fontsource/rubik/700.css';
import '@fontsource/cascadia-code/400.css';
import '@fontsource/cascadia-code/600.css';
import "./App.css";

render(() => <App />, document.getElementById("root") as HTMLElement);
