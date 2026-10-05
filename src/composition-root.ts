import { Router } from 'express';
import { DataSource } from 'typeorm';

export interface RouterMount {
  path: string;
  router: Router;
}

export interface Container {
  // Unauthenticated routes (e.g. public share-link tracking, Phase 10).
  publicRouters: RouterMount[];
  // Authenticated, tenant-scoped routes (trips, vehicles, org settings, ...).
  routers: RouterMount[];
}

/**
 * Hand-wired dependency graph, same pattern as the main loadsmart backend: each module exports a
 * createXModule(dataSource, deps) factory returning { service, router }, wired here. Empty until
 * Phase 1 adds the first modules.
 */
export function buildContainer(_dataSource: DataSource): Container {
  return {
    publicRouters: [],
    routers: [],
  };
}
