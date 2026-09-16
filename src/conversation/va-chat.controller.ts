import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AssessmentService } from './assessment.service';
import { ProviderFactory } from '../ai/provider-factory';
import {
  sanitiseBase64Image,
  UnsupportedImageError,
} from '../core/images/image-sanitiser';
import { RateLimitService } from '../ratelimit/rate-limit.service';
import { Roles } from '../identity/auth/decorators/roles.decorator';
import { CurrentUser } from '../identity/auth/decorators/current-user.decorator';
import type { AccessTokenClaims } from '../identity/auth/auth.types';
import {
  APPLICATION_REPOSITORY,
  type IApplicationRepository,
} from '../applications/application.repository';
import {
  AskQuestionDto,
  AssessPostingDto,
  ExtractFromImageDto,
  RequestDraftDto,
} from './dto/chat.dto';

/**
 * The VA's whole surface for doing the work.
 *
 * Note what is here and what is not. A VA can assess a posting, ask for a
 * draft, ask a screening question, and read text out of a screenshot. There is
 * no route that returns the Client's profile, no route that lists protected
 * values, and no route that takes more than one application at a time.
 */
@ApiTags('va')
@Controller('va/chat')
@Roles('VA')
export class VaChatController {
  constructor(
    private readonly assessment: AssessmentService,
    private readonly providers: ProviderFactory,
    private readonly limits: RateLimitService,
    @Inject(APPLICATION_REPOSITORY) private readonly applications: IApplicationRepository,
  ) {}

  @Post('assess')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Paste a job description, get a fit score and a verdict',
    description:
      'Below the account owner’s threshold the verdict is "skip" and you do not ' +
      'need to ask — the reasoning is there if you want to double-check.',
  })
  async assess(@Body() dto: AssessPostingDto, @CurrentUser() user: AccessTokenClaims) {
    await this.limits.consumeVaMessage(user.sub);
    return this.assessment.assess({
      clientId: user.clientId,
      vaId: user.sub,
      ...dto,
    });
  }

  @Post('applications/:id/draft')
  @HttpCode(200)
  @ApiOperation({ summary: 'Get one finished, copy-paste ready answer' })
  async draft(
    @Param('id') applicationId: string,
    @Body() dto: RequestDraftDto,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    await this.limits.consumeVaMessage(user.sub);
    return this.assessment.draft({
      clientId: user.clientId,
      applicationId,
      kind: dto.kind,
      questionText: dto.questionText,
    });
  }

  @Get('applications/:id/drafts')
  @ApiOperation({ summary: 'Everything drafted for this application so far' })
  async drafts(@Param('id') applicationId: string) {
    return this.applications.drafts(applicationId);
  }

  @Post('ask')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Ask whether a screening question needs protected information',
    description:
      'Releases at most one field, only when the question genuinely requires it, ' +
      'and the account owner sees every release in their log.',
  })
  async ask(@Body() dto: AskQuestionDto, @CurrentUser() user: AccessTokenClaims) {
    await this.limits.consumeVaMessage(user.sub);
    await this.limits.consumeClientAiCall(user.clientId);
    return this.assessment.resolveDisclosure({
      questionText: dto.questionText,
      vaId: user.sub,
      applicationId: dto.applicationId,
    });
  }

  @Post('extract')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Read the text out of a screenshot of a posting',
    description: 'For when a job board will not let you select the text.',
  })
  async extract(
    @Body() dto: ExtractFromImageDto,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    await this.limits.consumeVaMessage(user.sub);
    await this.limits.consumeClientAiCall(user.clientId);

    /*
     * Sanitised before it leaves the building, not after.
     *
     * This is a screenshot taken on an assistant's own phone or laptop, and the
     * next thing that happens to it is being uploaded to a third-party model
     * provider. A phone screenshot's EXIF can carry GPS coordinates, the device
     * serial and the owner's name — none of which has anything to do with the
     * job posting, and none of which the assistant knows is travelling.
     *
     * It also verifies the bytes against the declared type. The DTO checks what
     * the caller SAID; this checks what they sent.
     */
    let image: string;
    try {
      image = sanitiseBase64Image(dto.image, dto.mediaType);
    } catch (e) {
      throw new UnprocessableEntityException(
        e instanceof UnsupportedImageError ? e.message : 'Could not read that image',
      );
    }

    const vision = await this.providers.visionExtractor();
    const result = await vision.extractText({
      image: { type: 'image', data: image, mediaType: dto.mediaType },
    });
    return { text: result.text };
  }
}
