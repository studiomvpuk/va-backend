import { Module } from '@nestjs/common';
import { TargetingController } from './targeting.controller';
import { TARGET_ROLE_REPOSITORY } from './target-role.repository';
import { PrismaTargetRoleRepository } from './prisma-target-role.repository';

@Module({
  controllers: [TargetingController],
  providers: [
    { provide: TARGET_ROLE_REPOSITORY, useClass: PrismaTargetRoleRepository },
  ],
  exports: [TARGET_ROLE_REPOSITORY],
})
export class TargetingModule {}
