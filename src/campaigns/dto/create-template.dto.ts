import { IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateTemplateDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsIn(['email', 'whatsapp', 'sms'])
  channel!: 'email' | 'whatsapp' | 'sms';

  @IsOptional()
  @IsString()
  subject?: string;

  @IsString()
  @IsNotEmpty()
  body!: string;
}

