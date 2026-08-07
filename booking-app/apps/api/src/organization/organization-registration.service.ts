import { Inject, Injectable } from '@nestjs/common';

import { PasswordService } from '../auth/password.service.js';
import { SessionStore } from '../auth/session.store.js';
import { AppError } from '../common/errors/app-error.js';
import { isUniqueViolation } from '../common/prisma-errors/prisma-errors.js';
import { ENV } from '../config/env.schema.js';
import { PrismaService } from '../prisma/prisma.service.js';

import { slugify, slugSuffix } from './slug.js';
import { StripeConnectService } from './stripe-connect.service.js';

import type { AppConfig } from '../config/env.schema.js';
import type {
  RegisterOrganizationRequest,
  RegisterOrganizationResponse,
} from '@shape-and-flow/booking-contracts';

const MAX_SLUG_ATTEMPTS = 5;

/** Business type Stripe expects, from the same discriminant the request already carries. */
function businessTypeFor(entityType: RegisterOrganizationRequest['entityType']): 'individual' | 'company' {
  return entityType === 'ORGANIZATION' ? 'company' : 'individual';
}

/** Legal name the Stripe account and the Organization row both use. */
function legalNameFor(request: RegisterOrganizationRequest): string {
  if (request.entityType === 'INDIVIDUAL') {
    return `${request.firstName} ${request.lastName}`;
  }
  return request.companyName;
}

@Injectable()
export class OrganizationRegistrationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionStore,
    private readonly stripeConnect: StripeConnectService,
    @Inject(ENV) private readonly config: AppConfig,
  ) {}

  async register(
    request: RegisterOrganizationRequest,
  ): Promise<{ response: RegisterOrganizationResponse; sid: string }> {
    const passwordHash = await this.passwords.hash(request.password);
    const { organization, owner } = await this.createOrganizationAndOwner(request, passwordHash);

    const onboardingLink = await this.startStripeOnboarding(request, organization.id);

    const sid = await this.sessions.create({
      id: owner.id,
      organizationId: owner.organizationId,
      role: owner.role,
      canIssueRefunds: owner.canIssueRefunds,
      employeeId: owner.employeeId,
    });

    return {
      response: { id: organization.id, slug: organization.slug, onboardingLink },
      sid,
    };
  }

  private async createOrganizationAndOwner(
    request: RegisterOrganizationRequest,
    passwordHash: string,
  ): Promise<{
    organization: { id: string; slug: string };
    owner: {
      id: string;
      organizationId: string;
      role: 'OWNER';
      canIssueRefunds: boolean;
      employeeId: string | null;
    };
  }> {
    const base = slugify(request.displayName);
    const legalName = legalNameFor(request);

    for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt += 1) {
      const slug = attempt === 0 ? base : `${base}-${slugSuffix()}`;

      try {
        return await this.prisma.$transaction(async (tx) => {
          const organization = await tx.organization.create({
            data: {
              slug,
              name: request.displayName,
              legalName,
              contactEmail: request.email,
              contactPhone: request.contactPhone,
              ...(request.whatsappNumber === undefined ? {} : { whatsappNumber: request.whatsappNumber }),
              addressLine1: request.addressLine1,
              ...(request.addressLine2 === undefined ? {} : { addressLine2: request.addressLine2 }),
              postalCode: request.postalCode,
              city: request.city,
              country: request.country,
              entityType: request.entityType,
              isSmallBusiness: request.isSmallBusiness,
              ...(request.entityType === 'INDIVIDUAL' || request.entityType === 'SOLE_PROPRIETORSHIP'
                ? { ownerFirstName: request.firstName, ownerLastName: request.lastName }
                : {}),
              ...(request.taxId === undefined ? {} : { taxId: request.taxId }),
              ...(request.vatId === undefined ? {} : { vatId: request.vatId }),
            },
          });

          await tx.organizationSettings.create({
            data: {
              organizationId: organization.id,
              officeNotificationEmail: request.email,
            },
          });

          const owner = await tx.officeUser.create({
            data: {
              organizationId: organization.id,
              email: request.email,
              passwordHash,
              firstName: request.entityType === 'ORGANIZATION' ? request.companyName : request.firstName,
              lastName: request.entityType === 'ORGANIZATION' ? '' : request.lastName,
              role: 'OWNER',
              canIssueRefunds: true,
            },
          });

          return {
            organization: { id: organization.id, slug: organization.slug },
            owner: {
              id: owner.id,
              organizationId: owner.organizationId,
              role: 'OWNER' as const,
              canIssueRefunds: owner.canIssueRefunds,
              employeeId: null,
            },
          };
        });
      } catch (error) {
        if (isUniqueViolation(error, 'slug') && attempt < MAX_SLUG_ATTEMPTS - 1) continue;
        if (isUniqueViolation(error, 'slug')) {
          throw new AppError('ORGANIZATION_CREATE_ERROR', {
            message: 'Could not allocate a unique organization slug.',
            cause: error,
          });
        }
        throw new AppError('ORGANIZATION_CREATE_ERROR', {
          message: 'Could not create organization.',
          cause: error,
        });
      }
    }

    // Unreachable: every loop iteration either returns or throws.
    throw new AppError('ORGANIZATION_CREATE_ERROR', {
      message: 'Could not allocate a unique organization slug.',
    });
  }

  /**
   * Best-effort: start Stripe onboarding for the organization just created.
   *
   * Returns null rather than throwing when Stripe is unreachable or unconfigured — the
   * organization and its owner are already committed by this point, and onboarding can
   * be retried from the office via POST /office/organization/onboarding-link (Task 7),
   * so there is nothing to roll back here.
   */
  private async startStripeOnboarding(
    request: RegisterOrganizationRequest,
    organizationId: string,
  ): Promise<string | null> {
    try {
      const { stripeAccountId } = await this.stripeConnect.createExpressAccount({
        email: request.email,
        country: request.country,
        businessType: businessTypeFor(request.entityType),
      });

      await this.prisma.organization.update({
        where: { id: organizationId },
        data: { stripeAccountId },
      });

      const returnUrl = request.returnUrl ?? this.defaultReturnUrl();
      const { url } = await this.stripeConnect.createAccountLink(stripeAccountId, returnUrl);
      return url;
    } catch {
      // Organization and owner are already committed. Onboarding can be
      // retried from the office via POST /office/organization/onboarding-link
      // (Task 7) — nothing to roll back here.
      return null;
    }
  }

  private defaultReturnUrl(): string {
    return `${this.config.PUBLIC_WEB_ORIGIN}/office/onboarding-status`;
  }
}
