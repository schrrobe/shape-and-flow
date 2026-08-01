import { Global, Module } from '@nestjs/common';

import { OutboxDispatcher, OutboxDispatcherScheduler } from './outbox.dispatcher.js';
import { OutboxReconciler } from './outbox.reconciler.js';
import { OutboxRecorder } from './outbox.recorder.js';

/**
 * The outbox.
 *
 * Global because the recorder belongs to every write path: any service that
 * changes state and needs a consequence to follow records here, and threading an
 * import through each of those modules would add nothing.
 *
 * The scheduler is registered in both process roles and starts in neither unless
 * `APP_ROLE=worker` — see OutboxDispatcherScheduler.
 */
@Global()
@Module({
  providers: [OutboxRecorder, OutboxDispatcher, OutboxDispatcherScheduler, OutboxReconciler],
  exports: [OutboxRecorder, OutboxDispatcher, OutboxReconciler],
})
export class OutboxModule {}
