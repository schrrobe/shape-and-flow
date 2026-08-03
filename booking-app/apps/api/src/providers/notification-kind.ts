import type { Locale as PrismaLocale, NotificationKind } from '../prisma/client.js';

/**
 * Re-exported so the provider ports do not each import from Prisma directly.
 *
 * The ports are infrastructure and the kinds are domain vocabulary; naming them in
 * one place keeps the direction of that dependency visible, and gives a single
 * edit point if the notification kinds ever move into the contracts package.
 */
export type NotificationKindValue = NotificationKind;
export type Locale = PrismaLocale;
