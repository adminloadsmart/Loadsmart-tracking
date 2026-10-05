// Single source of truth for the API's URL version prefix — read by app.ts (which prepends it to
// every publicRouters/authenticatedRouters/routers mount) and by every module's *.openapi.ts
// (whose BASE constant must match the real mounted URL for the generated Swagger spec to stay
// accurate). Deliberately NOT applied to /health or /docs in app.ts — health checks and the docs
// UI itself aren't versioned API resources.
export const API_VERSION_PREFIX = '/v1';
