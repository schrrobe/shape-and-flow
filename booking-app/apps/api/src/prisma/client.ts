/**
 * Single re-export point for the generated Prisma client.
 *
 * Prisma 7's `prisma-client` generator emits TypeScript source rather than a
 * prebuilt package, so it is compiled as part of this app. Everything imports
 * the client through this barrel, which means the generated output location is
 * referenced in exactly one file and can be moved without touching call sites.
 *
 * `export *` is deliberate: it carries the PrismaClient class, the `Prisma`
 * namespace, the model types, and — importantly — the enum objects, which the
 * generator emits as real runtime `const` values, not just types. Re-exporting
 * only a hand-picked subset left `BookingStatus` and friends undefined at
 * runtime while still type-checking.
 *
 * The `.js` specifier is correct and required: under NodeNext, TypeScript
 * resolves `./x.js` to `./x.ts` at compile time and emits the `.js` path, so the
 * same import works in `tsc`, in the built output, and in Vitest.
 */
export * from '../generated/prisma/client.js';
