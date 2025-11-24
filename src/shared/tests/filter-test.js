import { mount } from 'svelte';
import FilterTest from './FilterTest.svelte';

const app = mount(FilterTest, {
  target: document.getElementById('app')
});

export default app;
