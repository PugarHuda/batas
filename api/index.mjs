// Vercel entry point. The service is the same Express app that runs locally; Vercel Functions
// serve it directly, so there is one implementation rather than a hosted copy that can drift.
export { default } from '../agent/service.mjs';
