import { mount } from 'svelte';
import TooltipTest from './TooltipTest.svelte';

const app = mount(TooltipTest, {
  target: document.getElementById('app')
});

export default app;
