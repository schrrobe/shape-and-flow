import { Injectable, Logger } from '@nestjs/common';

import { OrganizationContextService } from '../organization/organization-context.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

import type { OrganizationWithSettings } from '../organization/organization-context.service.js';
import type {
  OfficeSettingsResponse,
  UpdateOfficeSettingsRequest,
} from '@shape-and-flow/booking-contracts';

/**
 * The one form that changes how the whole domain behaves.
 *
 * `OrganizationContextService` caches the organization and its settings once at
 * bootstrap, which is what keeps the availability engine from re-reading policy on
 * every request. That cache is the reason this service exists rather than being three
 * lines in a controller: **every successful write refreshes it**, so the next
 * availability request answers with the interval that was just saved rather than the
 * one the process started with. Without the refresh the change would appear to work —
 * the row is updated, `GET /office/settings` reads it back — and take effect on the
 * next deploy.
 */
@Injectable()
export class SettingsService {
  private readonly logger = new Logger('Settings');

  constructor(
    private readonly prisma: PrismaService,
    private readonly organizations: OrganizationContextService,
  ) {}

  read(): OfficeSettingsResponse {
    // From the cache, deliberately: this is the same object every policy decision in
    // the process is made against, so what the office sees is what the domain uses.
    return toDto(this.organizations.get());
  }

  /**
   * Apply a patch, then reload the cache.
   *
   * The two writes are one transaction because identity and policy are edited in one
   * form: half a saved form is worse than a rejected one.
   */
  async update(patch: UpdateOfficeSettingsRequest): Promise<OfficeSettingsResponse> {
    const organization = this.organizations.get();
    const { organization: identity, ...settings } = patch;

    const identityData = defined(identity ?? {});
    const settingsData = defined({
      ...settings,
      // Sorted and de-duplicated on write. Two identical offsets would produce two
      // identical reminders, and the reminder job's id is keyed by offset — so the
      // duplicate would be dropped by BullMQ rather than by anything that could
      // explain itself.
      ...(settings.reminderOffsetsMinutes === undefined
        ? {}
        : {
            reminderOffsetsMinutes: [...new Set(settings.reminderOffsetsMinutes)].sort(
              (left, right) => left - right,
            ),
          }),
    });

    await this.prisma.$transaction(async (tx) => {
      if (Object.keys(identityData).length > 0) {
        await tx.organization.update({
          where: { id: organization.id },
          data: identityData,
          select: { id: true },
        });
      }

      if (Object.keys(settingsData).length > 0) {
        await tx.organizationSettings.update({
          where: { organizationId: organization.id },
          data: settingsData,
          select: { id: true },
        });
      }
    });

    // `refreshCurrent`, not `refresh`: an office request runs inside a tenant scope, and
    // `refresh` only replaces the bootstrap fallback that a scoped request never reads.
    // Left at that, this method would return the values from before the transaction — the
    // form would be overwritten with the user's old input and the audit row would record
    // a change from a value to itself.
    const reloaded = await this.organizations.refreshCurrent(organization.id);
    this.logger.log('organization settings updated; cached context refreshed');

    return toDto(reloaded);
  }
}

/**
 * A patch with its absent keys actually absent.
 *
 * `exactOptionalPropertyTypes` is on, and a parsed partial has every key present with
 * an `undefined` value — which to Prisma means "write undefined" rather than "leave it
 * alone", and is a type error rather than a silent one. Stripping them here is what
 * lets a patch of one field stay a patch of one field.
 */
function defined<T extends object>(patch: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}

function toDto(organization: OrganizationWithSettings): OfficeSettingsResponse {
  const settings = organization.settings;

  return {
    organization: {
      id: organization.id,
      name: organization.name,
      legalName: organization.legalName,
      contactEmail: organization.contactEmail,
      contactPhone: organization.contactPhone,
      whatsappNumber: organization.whatsappNumber,
      addressLine1: organization.addressLine1,
      addressLine2: organization.addressLine2,
      postalCode: organization.postalCode,
      city: organization.city,
      country: organization.country,
      timezone: organization.timezone,
      currency: organization.currency,
      defaultLocale: organization.defaultLocale,
    },
    schedulingIntervalMinutes: settings.schedulingIntervalMinutes,
    bookingHorizonDays: settings.bookingHorizonDays,
    minimumNoticeHours: settings.minimumNoticeHours,
    reservationTtlMinutes: settings.reservationTtlMinutes,
    freeCancellationHours: settings.freeCancellationHours,
    cancellationFeePolicy: settings.cancellationFeePolicy,
    cancellationFeeAmountCents: settings.cancellationFeeAmountCents,
    cancellationFeePercent: settings.cancellationFeePercent,
    reminderOffsetsMinutes: settings.reminderOffsetsMinutes,
    smsRemindersEnabled: settings.smsRemindersEnabled,
    customerNoteEnabled: settings.customerNoteEnabled,
    dataRetentionDays: settings.dataRetentionDays,
    officeNotificationEmail: settings.officeNotificationEmail,
  };
}
