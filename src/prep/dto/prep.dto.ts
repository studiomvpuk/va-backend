import { ApiProperty } from '@nestjs/swagger';

export class PrepQuestionDto {
  @ApiProperty() question!: string;
  @ApiProperty() why!: string;
}

export class TalkingPointDto {
  @ApiProperty() point!: string;
  @ApiProperty({
    description:
      'Where this came from: a profile field key, the experience narrative, ' +
      'or a cited source URL. Every point has one — points that could not be ' +
      'attributed are discarded before the document is stored.',
  })
  basis!: unknown;
}

export class PrepDocumentDto {
  @ApiProperty() id!: string;
  @ApiProperty() applicationId!: string;
  @ApiProperty({ enum: ['PENDING', 'READY', 'FAILED'] }) status!: string;
  @ApiProperty({ nullable: true }) failureReason!: string | null;
  @ApiProperty({ nullable: true }) companyBackground!: string | null;
  @ApiProperty({ type: [PrepQuestionDto] }) likelyQuestions!: PrepQuestionDto[];
  @ApiProperty({ type: [TalkingPointDto] }) talkingPoints!: TalkingPointDto[];
  @ApiProperty({ type: [String] }) sources!: string[];
  @ApiProperty({ nullable: true }) generatedAt!: Date | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() companyName!: string;
  @ApiProperty() roleTitle!: string;
}
