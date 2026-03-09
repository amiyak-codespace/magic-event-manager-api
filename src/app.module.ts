import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module';
import { EventsModule } from './events/events.module';
import { UsersModule } from './users/users.module';
import { CampaignTemplatesModule } from './campaigns/campaign-templates.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    AuthModule,
    EventsModule,
    UsersModule,
    CampaignTemplatesModule,
  ],
})
export class AppModule {}
