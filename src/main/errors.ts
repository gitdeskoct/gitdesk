// An error whose message was written for the person using gitdesk. Only these cross IPC as-is;
// anything else is logged in main and replaced with a generic message, so stray paths or Git
// output never reach the renderer.
export class UserError extends Error {}
