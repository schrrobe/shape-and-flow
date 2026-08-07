import { z } from 'zod';

export const featureFlagClientConfigSchema = z
  .object({
    url: z.url(),
    clientKey: z.string().min(1),
    appName: z.literal('shape-and-flow-booking-web'),
    environment: z.enum(['development', 'production']),
    deployment: z.enum(['dev', 'stage', 'production']),
  })
  .strict();

export type FeatureFlagClientConfig = z.infer<typeof featureFlagClientConfigSchema>;
