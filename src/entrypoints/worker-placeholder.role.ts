import { RoleStarter } from '../shared/lifecycle/role-runner';

/**
 * Placeholder for roles whose work arrives in later phases — the poller (BlackRock/Intugine/ULIP
 * pull workers, Phase 4+). Registers a readiness check so the deployment shape, probes and
 * shutdown path can be exercised now.
 */
export function placeholderRole(name: string, arrivesIn: string): RoleStarter {
  return async ({ health, logger }) => {
    logger.info({ arrivesIn }, `${name} role has no work yet`);
    health.register(name, async () => ({ state: 'idle', arrivesIn }));
    return {
      async stop() {
        health.unregister(name);
      },
    };
  };
}

export const startPollerRole = placeholderRole('poller', 'Phase 4: provider pull workers');
