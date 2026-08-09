import { Inject, Injectable, Logger } from '@nestjs/common';

import { AppError } from '../common/errors/app-error.js';
import { isUniqueViolation } from '../common/prisma-errors/prisma-errors.js';
import { ENV } from '../config/env.schema.js';
import { isCentralHost, normalizeHostname } from '../organization/hostname.js';
import { OrganizationContextService } from '../organization/organization-context.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

import type { AppConfig } from '../config/env.schema.js';
import type { OrganizationDomain } from '../prisma/client.js';
import type {
  CreateOrganizationDomainRequest,
  OrganizationDomainDto,
  OrganizationDomainListResponse,
  OrganizationDomainMutationResponse,
} from '@shape-and-flow/booking-contracts';

/** The columns the DTO is built from, so no query reads more of the row than it needs. */
const DOMAIN_SELECT = {
  id: true,
  hostname: true,
  isPrimary: true,
  verifiedAt: true,
  createdAt: true,
} as const;

/**
 * The hostnames an organization's public booking flow answers under.
 *
 * Registering one is a routing change, not a settings change: from the moment the row
 * exists, every request arriving at that hostname is served as this organization,
 * `?organizer=` and all. Three rules follow from that, and all three live here because
 * the resolver deliberately does no validation of its own — it looks up exactly what it
 * was given and trusts the row.
 *
 *  - The hostname is normalized before it is stored, to the one spelling the resolver
 *    will produce from a `Host` header. An unnormalized row is not a wrong row, it is an
 *    unreachable one.
 *  - A central hostname cannot be registered. The central address is where
 *    `?organizer=` picks the tenant; an organization that claimed it would take over
 *    every other organizer's links.
 *  - A hostname belongs to at most one organization, enforced by a unique index rather
 *    than a read-then-write, because a check-then-insert loses the race that matters.
 */
@Injectable()
export class OrganizationDomainsService {
  private readonly logger = new Logger('OrganizationDomains');

  constructor(
    private readonly prisma: PrismaService,
    private readonly organizations: OrganizationContextService,
    @Inject(ENV) private readonly config: AppConfig,
  ) {}

  async list(): Promise<OrganizationDomainListResponse> {
    const domains = await this.prisma.organizationDomain.findMany({
      where: { organizationId: this.organizations.getOrganizationId() },
      // Primary first, then oldest first: the preferred address at the top, and a
      // stable order for the rest so the list does not reshuffle between reads.
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
      select: DOMAIN_SELECT,
    });

    return { domains: domains.map(toDto) };
  }

  async add(input: CreateOrganizationDomainRequest): Promise<OrganizationDomainMutationResponse> {
    const organizationId = this.organizations.getOrganizationId();
    const hostname = normalizeHostname(input.hostname);

    if (hostname === null) {
      throw new AppError('VALIDATION_FAILED', {
        message: 'The hostname must be a plain domain name, for example studio-muster.de.',
        details: { field: 'hostname' },
      });
    }

    if (isCentralHost(hostname, this.config)) {
      // Not a 409: nobody owns this hostname, it is simply not available to own. Saying
      // so plainly beats letting an owner wonder which competitor took it.
      throw new AppError('VALIDATION_FAILED', {
        message: 'That hostname is the platform address and cannot be assigned.',
        details: { field: 'hostname' },
      });
    }

    try {
      const domain = await this.prisma.$transaction(async (tx) => {
        if (input.isPrimary) {
          // The partial unique index permits one primary per organization, so the
          // previous holder has to step down in the same transaction that promotes the
          // new one — otherwise the insert fails against a constraint the caller never
          // asked about.
          await tx.organizationDomain.updateMany({
            where: { organizationId, isPrimary: true },
            data: { isPrimary: false },
          });
        }

        return await tx.organizationDomain.create({
          data: { hostname, organizationId, isPrimary: input.isPrimary },
          select: DOMAIN_SELECT,
        });
      });

      this.logger.log(`domain registered: ${hostname}`);

      return { domain: toDto(domain) };
    } catch (error) {
      if (isUniqueViolation(error, 'hostname')) {
        // Identical answer whether the row belongs to this organization or another
        // one. The alternative leaks which domains the platform's other customers have
        // registered to anybody with an office account and a word list.
        throw new AppError('ORGANIZATION_DOMAIN_TAKEN', {
          message: 'That hostname is already registered.',
          details: { field: 'hostname' },
        });
      }

      throw error;
    }
  }

  async remove(id: string): Promise<OrganizationDomainMutationResponse> {
    const organizationId = this.organizations.getOrganizationId();

    // Both statements filter on the tenant, and `deleteMany` rather than `delete` so
    // the second one cannot reach a row the first did not authorize. A domain belonging
    // to another organization is indistinguishable from one that never existed — same
    // 404, no confirmation that the id is real.
    const domain = await this.prisma.organizationDomain.findFirst({
      where: { id, organizationId },
      select: DOMAIN_SELECT,
    });

    if (domain === null) {
      throw new AppError('NOT_FOUND', { message: 'Domain not found.' });
    }

    await this.prisma.organizationDomain.deleteMany({ where: { id, organizationId } });
    this.logger.log(`domain removed: ${domain.hostname}`);

    return { domain: toDto(domain) };
  }
}

function toDto(
  domain: Pick<OrganizationDomain, keyof typeof DOMAIN_SELECT>,
): OrganizationDomainDto {
  return {
    id: domain.id,
    hostname: domain.hostname,
    isPrimary: domain.isPrimary,
    verifiedAt: domain.verifiedAt === null ? null : domain.verifiedAt.toISOString(),
    createdAt: domain.createdAt.toISOString(),
  };
}
