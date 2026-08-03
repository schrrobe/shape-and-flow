import { Global, Module } from '@nestjs/common';

import { InboxReconciler } from './inbox.reconciler.js';
import { InboxRecorder } from './inbox.recorder.js';

/**
 * The webhook inbox.
 *
 * Global for the same reason the outbox is: the recorder belongs to every inbound
 * webhook controller and every processor that handles one, and threading an import
 * through each of those adds nothing.
 *
 * No scheduler here. Unlike the outbox — which needs a tight interval and so runs
 * on a timer — the inbox reconciler is a two-minute sweep, which is what the
 * MAINTENANCE queue's `sweep.inbox` job is for. That job is registered with the
 * worker in stage 7.
 */
@Global()
@Module({
  providers: [InboxRecorder, InboxReconciler],
  exports: [InboxRecorder, InboxReconciler],
})
export class InboxModule {}
