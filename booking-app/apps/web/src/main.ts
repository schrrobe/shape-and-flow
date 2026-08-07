import { createPinia } from 'pinia';
import { createApp } from 'vue';

import App from './App.vue';
import { createFeatureFlagClient, FEATURE_FLAG_CLIENT } from './feature-flags/client.js';
import { i18n } from './i18n/index.js';
import { router } from './router/index.js';

import './styles/main.css';

// Typed linting cannot see inside a single-file component, so `App` is `any` to it while
// `vue-tsc` types it correctly. Disabled here rather than switching the rule off for the package,
// which would hide a genuine unsafe argument somewhere else.
// eslint-disable-next-line @typescript-eslint/no-unsafe-argument
const app = createApp(App).use(createPinia()).use(i18n).use(router);
const featureFlags = createFeatureFlagClient();

app.provide(FEATURE_FLAG_CLIENT, featureFlags);
app.onUnmount(() => {
  featureFlags.stop();
});
app.mount('#app');

// Feature availability must never delay the first render.
void featureFlags.start();
