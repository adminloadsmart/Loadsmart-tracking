import type { DataSource } from 'typeorm';
import type { Logger } from 'pino';
import type { Role } from '../../config/roles';
import type { HealthRegistry } from './health';
import { roleUp } from '../metrics';

/** What every role gets at startup — shared infra, already connected. */
export interface RoleContext {
  dataSource: DataSource;
  health: HealthRegistry;
  logger: Logger;
}

export interface RunningRole {
  stop(): Promise<void>;
}

export type RoleStarter = (ctx: RoleContext) => Promise<RunningRole>;

export interface StartedRole {
  name: Role;
  handle: RunningRole;
}

/**
 * Starts roles in the given order. If one fails to start, the ones already running are stopped
 * (reverse order) before the error propagates, so a half-booted process never lingers.
 */
export async function startRoles(
  roles: Role[],
  starters: Record<Role, RoleStarter>,
  ctx: RoleContext,
): Promise<StartedRole[]> {
  const started: StartedRole[] = [];
  try {
    for (const name of roles) {
      const roleLogger = ctx.logger.child({ role: name });
      const handle = await starters[name]({ ...ctx, logger: roleLogger });
      started.push({ name, handle });
      roleUp.set({ role: name }, 1);
      roleLogger.info('Role started');
    }
  } catch (err) {
    await stopRoles(started, ctx.logger);
    throw err;
  }
  return started;
}

/** Stops roles in reverse start order; one role failing to stop doesn't block the others. */
export async function stopRoles(started: StartedRole[], logger: Logger): Promise<void> {
  for (const { name, handle } of [...started].reverse()) {
    try {
      await handle.stop();
      logger.info({ role: name }, 'Role stopped');
    } catch (err) {
      logger.error({ err, role: name }, 'Role failed to stop cleanly');
    } finally {
      roleUp.set({ role: name }, 0);
    }
  }
}
