/**
 * The metadata key the global `AuthGuard` reads, on its own.
 *
 * Split out because the guard needs nothing but this string, and importing it from
 * `management-token.guard.ts` dragged `ManagementTokenService`, `PrismaService` and the
 * Express types into `common/` — making the layer that is supposed to know nothing about
 * features depend on the manage feature.
 */
export const MANAGEMENT_TOKEN_ROUTE = 'auth:management-token';
