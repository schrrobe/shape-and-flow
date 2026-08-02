import { SetMetadata } from '@nestjs/common';

/** Metadata key the global guard reads. */
export const IS_PUBLIC = 'auth:public';

/**
 * Open this route to unauthenticated callers.
 *
 * The default is closed: the global `AuthGuard` denies anything that is not marked
 * here and carries no credential. That direction matters more than it looks. A guard
 * that opts routes *in* to protection fails silently when someone forgets — a new
 * office endpoint would simply be public, and nothing about the code would look
 * wrong. This way forgetting produces a 401 on the first request, which is a bug
 * report rather than a breach.
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true);
