import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../identity/auth/decorators/roles.decorator';
import { ConcealFromOtherRoles } from '../identity/auth/decorators/conceal.decorator';
import { PrepService } from './prep.service';
import { PrepDocumentDto } from './dto/prep.dto';

/**
 * Interview prep documents. Client-only, and concealed rather than refused.
 *
 * `@ConcealFromOtherRoles` at the class level covers every route here,
 * including any added later — the decision is about the resource, not about one
 * endpoint. An architecture test asserts this class carries it.
 *
 * There is no POST. A prep document is requested by moving an application to
 * INTERVIEW, which is a fact about the job search rather than a separate
 * action, and having two ways to trigger it would mean two places where the
 * idempotency could be got wrong.
 */
@ApiTags('prep')
@Controller('applications/:applicationId/prep')
@Roles('CLIENT')
@ConcealFromOtherRoles()
export class PrepController {
  constructor(private readonly prep: PrepService) {}

  @Get()
  @ApiOperation({
    summary: 'Interview notes for one application',
    description:
      'PENDING while the research runs, READY when it is written, FAILED when ' +
      'nothing could be verified. 404 until the application reaches INTERVIEW.',
  })
  async find(@Param('applicationId') applicationId: string): Promise<PrepDocumentDto> {
    const document = await this.prep.find(applicationId);
    // Tenant-scoped, so another Client's application id is simply not found.
    if (!document) throw new NotFoundException('No interview notes for this application');
    return document;
  }
}
