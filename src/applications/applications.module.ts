import { forwardRef, Module } from '@nestjs/common';
import { ApplicationsController } from './applications.controller';
import { APPLICATION_REPOSITORY } from './application.repository';
import { PrismaApplicationRepository } from './prisma-application.repository';
import { PrepModule } from '../prep/prep.module';

/**
 * forwardRef, and the cycle it resolves is real rather than accidental:
 * marking INTERVIEW requests a prep document, and generating one reads the
 * application it is for.
 *
 * The alternative — an event bus between them — would buy decoupling at the
 * cost of making "what happens when I mark INTERVIEW" unanswerable by reading
 * the code. Two modules that genuinely need each other is the honest shape.
 */
@Module({
  imports: [forwardRef(() => PrepModule)],
  controllers: [ApplicationsController],
  providers: [
    { provide: APPLICATION_REPOSITORY, useClass: PrismaApplicationRepository },
  ],
  exports: [APPLICATION_REPOSITORY],
})
export class ApplicationsModule {}
