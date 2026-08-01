import { Global, Module } from '@nestjs/common';

import { PrismaLifecycle } from './prisma.lifecycle.js';
import { PrismaService } from './prisma.service.js';

@Global()
@Module({
  providers: [PrismaService, PrismaLifecycle],
  exports: [PrismaService],
})
export class PrismaModule {}
