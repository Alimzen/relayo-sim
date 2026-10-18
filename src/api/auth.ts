import { timingSafeEqual } from 'node:crypto';
import {
  createParamDecorator,
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { SIM_CONFIG, type SimConfig } from '../config.js';
import type { Project } from '../domain.js';
import { SimulationService } from '../simulation/simulation.service.js';

interface AuthedRequest {
  headers: Record<string, string | string[] | undefined>;
  project?: Project;
}

function bearer(req: AuthedRequest): string | undefined {
  const value = req.headers.authorization;
  const header = Array.isArray(value) ? value[0] : value;
  return header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
}

/** Requires `Authorization: Bearer <project API key>` and puts the project on the request. */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(@Inject(SimulationService) private readonly sim: SimulationService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const key = bearer(req);
    const project = key ? await this.sim.authenticate(key) : undefined;
    if (!project) throw new UnauthorizedException('Missing or invalid API key');
    req.project = project;
    return true;
  }
}

/** Requires `Authorization: Bearer <ADMIN_TOKEN>`. */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(@Inject(SIM_CONFIG) private readonly config: SimConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const given = Buffer.from(bearer(context.switchToHttp().getRequest<AuthedRequest>()) ?? '');
    const expected = Buffer.from(this.config.adminToken ?? '');
    if (!this.config.adminToken || given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new UnauthorizedException('Admin token required');
    }
    return true;
  }
}

export const CurrentProject = createParamDecorator(
  (_: unknown, context: ExecutionContext) => context.switchToHttp().getRequest<AuthedRequest>().project!,
);
