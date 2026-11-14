// Entry point for the forge: a shared in-memory Store behind a node:net HTTP/1.1
// server. main.ts keeps the make.fun lifecycle (listen(0) → register → poll done).
import { Store } from './src/store.ts';
import { ForgeServer } from './src/http.ts';
import { createHandler } from './src/router.ts';

export function createApp() {
  const store = new Store();
  const handler = createHandler(store);
  return new ForgeServer(handler);
}
