/**
 * Single re-export point for the generated Prisma client.
 *
 * Prisma 7's `prisma-client` generator emits TypeScript source rather than a
 * prebuilt package, so it is compiled as part of this app. Everything imports
 * the client through this barrel, which means the generated output location is
 * referenced in exactly one file and can be moved without touching call sites.
 *
 * The `.js` specifiers are correct and required: under NodeNext, TypeScript
 * resolves `./x.js` to `./x.ts` at compile time and emits the `.js` path, so
 * the same import works in `tsc`, in the built output, and in Vitest.
 */
export { Prisma, PrismaClient } from '../generated/prisma/client.js';
export type { Prisma as PrismaTypes } from '../generated/prisma/client.js';
