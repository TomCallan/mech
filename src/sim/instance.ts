import { SimHost } from './host';

/**
 * A single simulation instance shared by the render loop and the instrumentation
 * panels. Panels read from it on their own timers rather than through React
 * state, so nothing re-renders at simulation frequency.
 */
export const sim = new SimHost();
