import { mount } from 'svelte';
import App from './App.svelte';
import { fitStage } from '../shared/stage.svelte.js';

// Scale the design canvas before anything is laid out — see fitStage().
fitStage();

const app = mount(App, {
  target: document.getElementById('app')
});

export default app;
